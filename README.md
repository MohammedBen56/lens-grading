# Lens grading

A small website where invited graders classify strong-lens candidates found in COSMOS-Web DR1 by our MIRAGE-v1 and MIRAGE-v1.1 lens finders.

- **Access:** by invitation only. Accounts are created by the project admin; there is no sign-up.
- **Backend:** Supabase. The images and votes are stored there and protected by database access rules.
- **This repository holds only the static page.** `config.js` contains the project's public (publishable) key, which is meant to be public. Without an account it gives access to nothing.
