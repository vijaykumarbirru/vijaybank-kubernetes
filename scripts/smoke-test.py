"""End-to-end smoke test of VijayBank on the kind cluster.

Goes through Traefik -> nginx -> api-gateway, the same path as the browser, and checks login with
OTP, the read APIs, an IMPS transfer until settlement, a bill payment and the balance change.

    python3 scripts/smoke-test.py            # as demo customer VB100002
    python3 scripts/smoke-test.py VB100005   # any seeded customer VB100001..VB100020

Each run moves a little demo money, so customers' balances and daily limits change over time.
Uses 127.0.0.1 with a Host header because Python can't resolve *.localhost on macOS.
"""
import json, random, re, sys, time, uuid, urllib.request, urllib.error

BASE, HOST, CID = "http://127.0.0.1/api", "bank.localhost", sys.argv[1] if len(sys.argv) > 1 else "VB100002"
passed, failed = 0, []

def check(name, ok, info=""):
    global passed
    if ok: passed += 1; print(f"  PASS {name} {info}")
    else: failed.append(name); print(f"  FAIL {name} {info}")

def req(m, path, body=None, tok=None, headers=None, raw=False):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=m,
                               headers={"Host": HOST, "Content-Type": "application/json", **(headers or {})})
    if tok: r.add_header("Authorization", "Bearer " + tok)
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            data = x.read(); return x.status, (data if raw else json.loads(data or b"null"))
    except urllib.error.HTTPError as e:
        data = e.read()
        try: return e.code, json.loads(data or b"null")
        except ValueError: return e.code, data

def inbox(): return req("GET", f"/notifications/dev-inbox?customerId={CID}")[1] or []
def otp_after(before, contains=""):
    for _ in range(60):
        for m in inbox():
            if m["createdAt"] not in before and contains in m["message"]:
                g = re.search(r"\b(\d{6})\b", m["message"])
                if g: return g.group(1)
        time.sleep(0.5)

print(f"customer {CID}")
before = {m["createdAt"] for m in inbox()}
s, b = req("POST", "/auth/login", {"customerId": CID, "password": "Welcome@123"})
check("login (auth-service, Postgres)", s == 200 and "loginToken" in b, s)
otp = otp_after(before, "log in")
check("login OTP delivered (RabbitMQ -> notification-service -> Mongo)", bool(otp))
s, t = req("POST", "/auth/otp/verify", {"loginToken": b["loginToken"], "otp": otp})
tok = t.get("accessToken"); check("OTP verify -> JWT", s == 200 and bool(tok), s)

s, accts = req("GET", "/accounts", tok=tok); check("accounts (account-service)", s == 200 and len(accts) > 0, f"{len(accts)} account(s)")
sav = next(a for a in accts if a["accountNo"].startswith("1"))
bal0 = sav.get("balancePaise")
s, bens = req("GET", "/beneficiaries", tok=tok); check("beneficiaries (transfer-service)", s == 200, f"{len(bens)}")
s, x = req("GET", "/billers", tok=tok); check("billers (payment-service)", s == 200 and len(x) > 0, f"{len(x)}")
s, x = req("GET", "/cards", tok=tok); check("cards (card-service)", s == 200, f"{len(x)}")
s, x = req("GET", "/deposits", tok=tok); check("fixed deposits (account-service)", s == 200)
s, x = req("GET", f"/accounts/{sav['accountNo']}/transactions", tok=tok); check("transactions (statement-service -> ledger)", s == 200)
s, pdf = req("GET", f"/accounts/{sav['accountNo']}/statement.pdf", tok=tok, raw=True); check("statement PDF", s == 200 and pdf[:4] == b"%PDF", f"{len(pdf)} bytes")

ext = next((b for b in bens if b["type"] != "INTERNAL" and b["canReceive"] and not b.get("accountNo", "").endswith("0000")), None)
check("external beneficiary available", ext is not None)
before = {m["createdAt"] for m in inbox()}
s, tr = req("POST", "/transfers", {"fromAccountNo": sav["accountNo"], "mode": "IMPS", "beneficiaryId": ext["beneficiaryId"],
                                    "amountPaise": 120000, "remarks": "k8s smoke"}, tok, {"Idempotency-Key": str(uuid.uuid4())})
check("transfer create (fraud check)", s in (200, 201, 202) and tr.get("transferId"), f"{s} {tr.get('status')}")
s, tr = req("POST", f"/transfers/{tr['transferId']}/confirm", {"otp": otp_after(before, "to transfer")}, tok)
check("transfer confirm (OTP, ledger debit)", s == 200, f"{s} {tr.get('status')}")
status = tr.get("status")
for _ in range(40):
    if status in ("SETTLED", "COMPLETED", "FAILED", "REVERSED"): break
    time.sleep(0.5); status = req("GET", f"/transfers/{tr['transferId']}", tok=tok)[1].get("status")
check("transfer settled (RabbitMQ -> settlement-worker -> status update)", status in ("SETTLED", "COMPLETED"), status)

consumer = str(random.randint(10**9, 10**10 - 1))[:-1] + "7"
s, bill = req("POST", "/bill-payments/fetch", {"billerId": "METRO-POWER", "consumerNumber": consumer}, tok)
check("bill fetch", s == 200 and bill.get("dueAmountPaise"), s)
before = {m["createdAt"] for m in inbox()}
s, p = req("POST", "/bill-payments", {"billerId": "METRO-POWER", "consumerNumber": consumer, "amountPaise": bill["dueAmountPaise"],
                                      "fromAccountNo": sav["accountNo"]}, tok, {"Idempotency-Key": str(uuid.uuid4())})
check("bill payment create", s in (200, 201, 202) and p.get("paymentId"), f"{s} {p.get('status')}")
s, p = req("POST", f"/bill-payments/{p['paymentId']}/confirm", {"otp": otp_after(before)}, tok)
check("bill payment confirm", s == 200, f"{s} {p.get('status')}")

s, accts = req("GET", "/accounts", tok=tok)
bal1 = next(a for a in accts if a["accountNo"] == sav["accountNo"]).get("balancePaise")
check("balance went down by transfer + bill", bal0 is not None and bal1 is not None and bal0 - bal1 == 120000 + bill["dueAmountPaise"],
      f"{bal0} -> {bal1}")
s, n = req("GET", "/notifications", tok=tok); check("notifications list", s == 200, f"{len(n) if isinstance(n, list) else n}")

# Failure path: beneficiaries ending 0000 always fail settlement -> money must come back.
bad = next((b for b in bens if b["type"] != "INTERNAL" and b["canReceive"] and b.get("accountNo", "").endswith("0000")), None)
if bad:
    s, accts = req("GET", "/accounts", tok=tok); b0 = next(a for a in accts if a["accountNo"] == sav["accountNo"])["balancePaise"]
    before = {m["createdAt"] for m in inbox()}
    s, tr = req("POST", "/transfers", {"fromAccountNo": sav["accountNo"], "mode": "IMPS", "beneficiaryId": bad["beneficiaryId"],
                                        "amountPaise": 50000, "remarks": "k8s smoke fail"}, tok, {"Idempotency-Key": str(uuid.uuid4())})
    s, tr = req("POST", f"/transfers/{tr['transferId']}/confirm", {"otp": otp_after(before, "to transfer")}, tok)
    status = tr.get("status")
    for _ in range(40):
        if status in ("FAILED", "REVERSED", "COMPLETED"): break
        time.sleep(0.5); status = req("GET", f"/transfers/{tr['transferId']}", tok=tok)[1].get("status")
    s, accts = req("GET", "/accounts", tok=tok); b1 = next(a for a in accts if a["accountNo"] == sav["accountNo"])["balancePaise"]
    check("failed settlement is reversed (money returned)", status in ("FAILED", "REVERSED") and b0 == b1, f"{status}, {b0} -> {b1}")
else:
    print("  SKIP failure path (no beneficiary ending 0000 for this customer)")

print(f"\n{passed} passed, {len(failed)} failed" + (f": {failed}" if failed else ""))
