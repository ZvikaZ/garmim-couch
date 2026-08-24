"""One-off helper: perform garmin-mcp's normal login_interactive flow, but
read the MFA code from a FIFO instead of a real TTY (this process has none).

Not part of the installed package — a local script, safe to delete after
first-time auth. Never prints the password or the MFA code.
"""

from __future__ import annotations

import sys

from garmin_mcp.auth import AuthError, login_interactive, verify
from garmin_mcp.config import load_settings


def main() -> int:
    fifo_path = sys.argv[1]
    settings = load_settings()
    if not settings.garmin_email or not settings.garmin_password:
        print("GARMIN_EMAIL / GARMIN_PASSWORD not set in .env", file=sys.stderr)
        return 1

    def mfa_prompt() -> str:
        print(f"Waiting for MFA code on {fifo_path} ...", file=sys.stderr, flush=True)
        with open(fifo_path) as f:
            return f.readline().strip()

    try:
        client = login_interactive(
            email=settings.garmin_email,
            password=settings.garmin_password,
            tokens_path=settings.garmin_tokens_path,
            mfa_prompt=mfa_prompt,
        )
        name = verify(client)
    except AuthError as e:
        print(f"Login failed: {e}\nRemediation: {e.remediation}", file=sys.stderr)
        return 1

    print(f"Logged in as {name}. Tokens saved to {settings.garmin_tokens_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
