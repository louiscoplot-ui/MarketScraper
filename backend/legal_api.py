"""Legal pages — Terms of Service + Privacy Policy.

Both are served as plain JSON so the frontend renders them in whatever
shell it wants. Exempt from the global auth gate so the Login screen
footer links work for users who aren't signed in yet.

Wire into app.py:
    from legal_api import register_legal_routes
    register_legal_routes(app)
And add '/api/legal/' to _AUTH_EXEMPT_PREFIXES.
"""

import logging
from flask import jsonify

logger = logging.getLogger(__name__)

LEGAL_VERSION = '1.0'
LEGAL_DATE = 'May 2026'

TERMS_TEXT = """Version 1.0 — May 2026

1. Service
SuburbDesk is a productivity tool for real estate professionals. It centralises public market data and user-imported data for internal analysis purposes only.

2. User-Imported Data
The user is solely responsible for any data imported into SuburbDesk, including RP Data, CoreLogic or PriceFinder exports. The user warrants that they hold a valid licence for any third-party data imported. SuburbDesk does not redistribute this data and does not access it for its own commercial purposes.

3. Market Data
SuburbDesk aggregates publicly available information from the Western Australian property market for analysis and productivity purposes. Data is provided for informational purposes only. SuburbDesk does not warrant the accuracy, completeness or timeliness of any data displayed.

4. Limitation of Liability
SuburbDesk, its directors and employees shall not be liable for any financial loss, data loss, loss of revenue or indirect damage resulting from the use of or inability to use the service. SuburbDesk's total liability is limited to the amount paid by the user in the preceding 3 months.

5. Service Availability
SuburbDesk makes reasonable efforts to maintain service availability but provides no guaranteed uptime (SLA). Service interruptions may occur without notice.

6. Termination
SuburbDesk reserves the right to suspend or terminate access for any user in breach of these terms, without refund.

7. Governing Law
These terms are governed by the laws of Western Australia, Australia.
"""

PRIVACY_TEXT = """Version 1.0 — May 2026

1. Data Collected
SuburbDesk collects: name, email, phone and professional information at account creation; public WA property market data aggregated from public sources; data voluntarily imported by the user; technical usage logs.

2. Use of Data
Your data is used solely to provide the SuburbDesk service. It is never sold, shared or used for advertising purposes.

3. Data Isolation
Data imported by one user is strictly isolated and inaccessible to other users on the platform.

4. Retention
Account data is retained for the duration of the subscription and deleted within 90 days of cancellation. Imported data (RP Data, CoreLogic) can be deleted at any time upon request.

5. Security
SuburbDesk uses HTTPS, bcrypt-encrypted passwords and unique per-user access keys. No payment data is stored on our servers.

6. Your Rights
You may request access, correction or deletion of your data at any time by contacting suburbdesk@gmail.com

7. Compliance
SuburbDesk complies with the Privacy Act 1988 (Cth) and the Australian Privacy Principles (APPs).
"""


def get_terms():
    return jsonify({'content': TERMS_TEXT, 'version': LEGAL_VERSION, 'updated': LEGAL_DATE})


def get_privacy():
    return jsonify({'content': PRIVACY_TEXT, 'version': LEGAL_VERSION, 'updated': LEGAL_DATE})


def register_legal_routes(app):
    app.add_url_rule('/api/legal/terms', endpoint='legal_terms',
                     view_func=get_terms, methods=['GET'])
    app.add_url_rule('/api/legal/privacy', endpoint='legal_privacy',
                     view_func=get_privacy, methods=['GET'])
    logger.info("Legal routes registered: GET /api/legal/terms, GET /api/legal/privacy")
