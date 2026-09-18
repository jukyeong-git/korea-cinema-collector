"""One-shot diagnostic only: no AWS, persistence, alerts, retries, or proxy."""
import datetime
import json
import os
import time
from curl_cffi import requests

BASE = "https://cgv.co.kr"
PAGE = BASE + "/cnm/movieBook"


def query(session, name, params=None):
    started = time.monotonic()
    try:
        response = session.get(
            PAGE if params is None else BASE + "/api/v1/booking/" + name,
            params=params,
            headers=None if params is None else {
                "Accept": "application/json",
                "Accept-Language": "ko-KR,ko;q=0.9",
                "Referer": PAGE,
            },
            timeout=15,
        )
        result = {"api": name, "httpStatus": response.status_code,
                  "contentType": response.headers.get("content-type"),
                  "cfRay": response.headers.get("cf-ray"),
                  "retryAfter": response.headers.get("retry-after"),
                  "elapsedMs": round((time.monotonic() - started) * 1000)}
        ok = response.status_code == 200
        if params is not None and ok:
            try:
                payload = response.json()
                ok = isinstance(payload, dict) and payload.get("statusCode") == 0
                result["apiSuccess"] = ok
                data = payload.get("data") if isinstance(payload, dict) else None
                if name == "searchIfSeatData":
                    ok = ok and isinstance(data, dict) and str(data.get("resultCode")) == "0"
                    if ok:
                        ok = all(data.get(k) == params[k] for k in ["coCd", "siteNo", "scnYmd", "scnsNo"])
                        areas = data.get("items")
                        seats = [seat for area in areas for seat in area.get("seats", [])] if isinstance(areas, list) else []
                        ok = ok and bool(seats) and all(isinstance(s, dict) and all(k in s for k in ["seatRowNm", "seatNo", "seatSaleYn", "seatStusCd", "seatSalfrmCd"]) for s in seats)
                        result["seatCount"] = len(seats)
                else:
                    ok = ok and isinstance(data, list) and bool(data)
                    result["rowCount"] = len(data) if isinstance(data, list) else None
            except (ValueError, TypeError, AttributeError):
                ok = False
                result["validationError"] = "Unexpected JSON response shape"
        result["ok"] = ok
        # Intentionally omit cookies, raw HTML/body, and seat booking identifiers.
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return ok
    except requests.exceptions.RequestException as error:
        print(json.dumps({"api": name, "ok": False, "errorType": type(error).__name__}), flush=True)
        return False


def main():
    day = os.environ["CGV_DATE"]
    if len(day) != 8 or not day.isdigit():
        raise ValueError("CGV_DATE must be YYYYMMDD")
    datetime.datetime.strptime(day, "%Y%m%d")
    sequence = os.environ["CGV_SEQUENCE"]
    if not sequence.isdigit():
        raise ValueError("CGV_SEQUENCE must be numeric")
    common = {"coCd": "A420", "siteNo": "0013"}
    results = []
    with requests.Session(impersonate="chrome") as session:
        if not query(session, "booking-page"):
            return 1
        for name, params in [
            ("searchSiteScnscYmdListBySite", common),
            ("searchMovScnInfo", {**common, "scnYmd": day, "rtctlScopCd": "08"}),
            ("searchIfSeatData", {**common, "scnYmd": day, "scnsNo": "018", "scnSseq": sequence}),
        ]:
            results.append(query(session, name, params))
    print(json.dumps({"completed": len(results), "passed": sum(results), "failed": len(results) - sum(results)}))
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
