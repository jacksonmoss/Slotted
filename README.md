# Slotted

A free to-do app for iPhone that fits your tasks into the time you actually have. You set up time boxes (for example "Weeknights 7–9 pm"), add tasks, and it plans them into the boxes, most urgent first, telling you when each one will be done and which ones won't make their due date.

It's a web app you add to your Home Screen. No App Store, no account, no server: tasks are stored on the phone, and it works offline.

## Put it on your iPhone (GitHub Pages, free)

1. Create a GitHub account if you don't have one, then create a **public** repository (for example `slotted`). Free accounts can host Pages only from public repos. Your tasks never go to GitHub, only the app's code.
2. In the repo, choose **Add file → Upload files** and drag in every file from this folder. Commit.
3. Go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. After a minute, the site is live at `https://<your-username>.github.io/slotted/`.
5. Open that address in **Safari** on your iPhone, tap **Share**, then **Add to Home Screen**.

Open it from the Home Screen icon from then on. It runs full screen and keeps working without a connection.

**Back up now and then.** Tasks live only on that phone, in that app's storage. Use **Setup → Export backup** to save a file to iCloud Drive, and **Import backup** to restore it or move to a new phone. If you ever change the address the app is hosted at, export first and import at the new address.

## Using it

Type into the bar at the bottom. Details can go right in the text:

| Type | Means |
|---|---|
| `45m`, `1h`, `1.5h`, `1h30` | How long it takes |
| `by fri`, `by 11/3`, `today`, `tomorrow` | Due date |
| `after wed`, `from 11/1` | Don't start before |
| `daily`, `weekdays`, `weekly`, `every sat` | Repeats |
| `#school` | Category (a new name creates the category) |
| `!` (or `!low`) | High (or low) priority |

Anything you leave out gets suggested, and suggestions show with a dashed outline or dotted underline. Tap a task to change anything; saving it confirms the values.

When you check a task off, pick how long it really took. After three logs in a category, planning scales that category's estimates. If your "Home" tasks take 1.5× what you guess, they get planned at 1.5×. **Progress** shows the ratio per category.

**Skip today** on a box removes it from today's plan, for when the evening gets taken over.

## How the planning works

All of it is in `engine.js`, as pure functions.

- **Slack.** For each task with a due date, slack = minutes of matching box time before the due date − minutes of work left. Less slack means more urgent.
- **Score** = priority weight (low 1, normal 2, high 3.5) × urgency + a small bonus for tasks that have waited a long time. Urgency is 1 with no due date, and rises toward 5 as slack shrinks, scaled by your average box time per day.
- **Placement.** Tasks are placed highest score first, into the earliest box that accepts their category. Long tasks are split across boxes (pieces of 15–30 minutes minimum) unless you turn splitting off.
- **Rescue passes.** Anything that lands after its due date gets moved to the front, earliest deadline first, and the plan is rebuilt (up to 4 passes). If two deadlines still can't both fit, the higher priority one keeps its date.
- **At risk.** Whatever is still late is flagged, with the reason: how much is missing, or which day it would actually finish.
- **Target date.** A task's target date is the day its last piece is planned. That's the date shown on the right in **Tasks**.
- **Repeating tasks.** Each occurrence stays inside its own window: the day for daily tasks, Monday–Sunday for "weekly". A missed one is skipped, not stacked onto the next day.
- **Categories.** Category guesses come from a small starter vocabulary plus every task you've confirmed. Your corrections outweigh the starter words after one or two examples. Duration and priority guesses come from your most similar past tasks.

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app: screens, storage, interactions |
| `engine.js` | Parsing, suggestions and the planner (no UI code) |
| `engine.test.mjs` | Tests for the engine. Run with `node --test engine.test.mjs` (Node 20+) |
| `sw.js`, `manifest.webmanifest` | Offline support and Home Screen install |
| `archivo.woff2`, `archivo-OFL.txt` | The Archivo font and its license (SIL Open Font License) |
| `*.png` | App icons |

## Updating the app

After you change files and upload them, also change `VERSION` in `sw.js` (for example to `slotted-v2`). The phone picks up the new version the second time you open the app after the upload.

## Later: hosting on a Mac mini

Serve the folder from the Mac and reach it through [Tailscale](https://tailscale.com) so the iPhone gets HTTPS, which offline mode and Home Screen install require. Run `tailscale serve` pointing at a local static server, such as `python3 -m http.server 8080` started inside this folder.

A different address means different storage on the phone, so export a backup from the old copy and import it into the new one.
