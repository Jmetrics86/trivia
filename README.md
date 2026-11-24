# Iron Valor CrossFit Trivia

Mobile-first trivia host & scoreboard web app built for **Iron Valor CrossFit** (Delray Beach, FL), ready to publish on **GitHub Pages** with zero build steps.

## Categories (60 Starter Questions)
- **History** (15): Delray Beach local history, Palm Beach County WWII history, military valor & Hero WODs
- **Anatomy & Equipment** (15): Functional anatomy, lifting mechanics, barbell/plate specs, kettlebells & Concept2 gear
- **Music** (15): CrossFit box anthems, PR tracks & high-energy gym playlist artists
- **Food** (15): Macronutrients, micronutrients, hydration & athletic fueling

## Features
- **Mobile-first UI**: Designed for phones with a persistent scoreboard strip, large tap targets, and bottom tab navigation (**Play**, **Teams**, **Logs**, **Admin**).
- **Random Trivia Pull**: Draw non-repeating random questions across all categories or filter by category and difficulty (`100 / 200 / 300`).
- **Browser Persistence (`localStorage`)**: Teams, scores, asked-question deck, settings, custom questions, and activity logs persist in the browser.
- **Team & Score Admin**: Create, rename, and delete teams; switch active turn or award steals; make quick (`±50`, `±100`) or custom score adjustments.
- **Session Logs**: Filterable audit trail by team and action type, plus one-tap **CSV export**.
- **Admin Tools**: Toggle difficulty vs. flat scoring, wrong-answer point deductions, auto-rotate turn, Host Flashcard mode (hide A–D choices until tapped), custom question builder, and JSON backup/restore.

## Local Preview & Tests
Run the unit tests (Node 22+):
```bash
node --test tests/state.test.mjs
```

Serve locally over HTTP:
```bash
python3 -m http.server 8080
```
Then open `http://localhost:8080`.
