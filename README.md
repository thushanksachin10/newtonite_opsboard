# Opsboard: Operations Under Pressure

Opsboard is a web application that helps teams in a company manage operational work in one place. Examples of operational work include a customer problem, a production incident, a payment that needs investigation, a compliance request, or a task that needs approval.

Before an application like this exists, this kind of work is spread across chat messages, spreadsheets, email and conversations. Important requests get lost, two people unknowingly work on the same problem, and managers cannot see who owns what. Opsboard replaces that with a single shared list where every piece of work has an owner, a status, a priority and a complete history.

I built it for the Newtonite Software Engineering Challenge. The challenge intentionally leaves many decisions open, so this document explains what the application does and also why it behaves the way it does when several people act at the same time, when a request is sent twice, or when something fails.

## What the application does

- **Work items.** Each item has a title, a description, a priority, a due date, an owner, a status, and an optional requirement for approval.
- **Teams and roles.** A user can belong to several teams and can have a different role in each team. The roles are viewer, member, manager and administrator.
- **Workflow.** An item moves through these statuses: open, in progress, blocked, resolved and closed. The system refuses moves that make no sense, for example resolving an item that nobody owns.
- **Approvals.** An item can require approval before it can be resolved. The approval must come from a manager who is different from the person who requested it.
- **Overview.** The sidebar offers four views: "Needs attention", "My work", "Unassigned" and "All items".
- **Finding work.** Users can search by words, filter by team, status and priority, and sort by most recent update or by priority.
- **Collaboration.** Users can comment on items, reassign them, and read a complete timeline of everything that happened to an item.
- **Live updates.** When another person changes an item, the screen updates without a manual refresh. Users also receive in-app notifications.

## Technology used

| Part | Technology |
|---|---|
| Backend | Node.js with the Express web framework (version 5) |
| Database | MongoDB Atlas, using the official MongoDB driver and multi-document transactions |
| Frontend | Plain JavaScript in a single page, with no build step |
| Live updates | Server-Sent Events, a standard way for the server to push messages to the browser |
| Automated tests | The test runner that is built into Node.js |

## How the pieces fit together

1. The browser sends requests to the Express server and receives JSON responses.
2. The server passes each request to the service layer (`src/service.js`). The service layer asks the policy module (`src/policy.js`) whether the user is allowed to perform the action.
3. If the action is allowed, the service layer runs it inside one database transaction. That transaction updates the work item, writes an entry to the history, and saves a background job for notifications. Either all three are saved or none of them are.
4. A background worker (`src/outbox.js`) later picks up the saved job and creates the notifications.
5. The server tells connected browsers that something changed, and each browser fetches the new data through the normal, permission-checked interface.

The database holds these collections: users, teams, memberships, work items, item events (the history), idempotency records, an outbox of background jobs, and notifications. The application creates all indexes automatically when it starts.

## How to run the application

You need Node.js version 20.12 or newer, and a MongoDB Atlas cluster. The free tier is enough.

### Step 1: Prepare MongoDB Atlas

1. Create a free cluster on MongoDB Atlas.
2. Under "Database Access", create a database user with a username and a password.
3. Under "Network Access", add your current IP address.
4. Under "Connect", choose "Drivers" and copy the connection string. Replace the password placeholder in it with your real password.

### Step 2: Configure and start

Run these commands in the project folder:

```bash
cp .env.example .env
npm install
npm run seed
npm start
```

Before you run the second command, open the new `.env` file and paste your connection string into `MONGODB_URI`. Also set `TOKEN_SECRET` to a long random text.

- `npm run seed` creates demonstration users, teams and 300 work items. To test with more data, run `npm run seed -- 50000`.
- `npm start` starts the application at http://localhost:3000.

### Settings

| Setting | Meaning | Default |
|---|---|---|
| `MONGODB_URI` | The Atlas connection string. This setting is required. | none |
| `DB_NAME` | The name of the database | `opsboard` |
| `TOKEN_SECRET` | The secret used to sign login tokens. Always set a long random value. | a development-only value |
| `PORT` | The port the server listens on | `3000` |
| `DNS_SERVERS` | Optional. Public DNS servers such as `8.8.8.8,1.1.1.1`, for networks that cannot resolve Atlas addresses. | none |

### Common problems

- **The error `querySrv ECONNREFUSED`.** Your computer could not look up the Atlas address. Set `DNS_SERVERS=8.8.8.8,1.1.1.1` in the `.env` file, or use the older connection string that starts with `mongodb://`, which Atlas also offers under "Connect".
- **A timeout or an authentication failure.** Check that your IP address is listed under "Network Access" in Atlas. If your database password contains special characters, they must be URL-encoded in the connection string.

### Running the automated tests

```bash
npm test
```

The tests use the connection string from `.env` and create a temporary database with a name that starts with `opsboard_test_`. Each temporary database is deleted when its tests finish, so your demonstration data is never changed. If you do not set a connection string, the tests start a temporary in-memory MongoDB instead. That option downloads a MongoDB program the first time it runs.

## Demonstration accounts

On the sign-in page, click a name to sign in. Every demonstration account uses the password `password`.

| User | Role |
|---|---|
| Alice | Administrator in all four teams |
| Bob | Manager in Support and Engineering |
| Carol | Member in Support and Compliance |
| Dave | Member in Engineering |
| Erin | Member in Payments |
| Frank | Viewer in Support and Engineering. Frank can read but cannot change anything. |
| Gina | Member in Support, manager in Engineering, member in Payments |

These users do not all have the same abilities. Each user sees only the work items that belong to teams they are a member of. Inside a team, every member can see who owns each item.

## Try the important behaviours

Open two browser windows, one of them private, and sign in as different users.

1. **Two people claim the same item.** Sign in as Carol in one window and as Dave in the other. Both click "Take it" on the same unassigned item. One of them becomes the owner. The other sees the message "Too late" and the screen returns to the correct state.
2. **Two people edit from an outdated screen.** Open the same item as Bob and as Carol. Change the priority in one window. Then change it in the other window. The second change is refused with a message, and the screen shows the latest version.
3. **Approval.** As Carol, take an item that needs approval and request approval. Bob sees it under "Needs attention". Carol cannot approve her own request. Bob approves it, and only then can Carol resolve the item.
4. **Permissions.** Sign in as Frank. No action buttons are shown. If someone sends a change directly to the server as Frank, the server refuses it as well.
5. **Isolation between teams.** Sign in as Erin. Items from Support and Engineering are not visible to Erin at all.

## How the system stays correct

| Situation | What the system does |
|---|---|
| Two users claim the same work at the same moment | The claim is a single database update that only succeeds while the item has no owner. Exactly one user succeeds. The other receives a conflict response that contains the current state of the item. |
| A user edits an item from an outdated screen | Every change includes the version number the user last saw. The server applies the change only if that version is still current. Otherwise it refuses the change and returns the latest item. No one's change is silently overwritten. |
| A request is sent twice, for example by a double click or a network retry | The client sends a unique key with each action. The server stores that key together with the result in the same transaction. A repeated request returns the original result and does not repeat the action. A unique database index makes this safe even when two identical requests arrive at the same time. |
| The user lacks permission | One function decides what each role may do. The server enforces it on every request. The screen uses the same function only to hide buttons. A user outside a team receives a "not found" response, so the user cannot even tell that an item exists. |
| The workflow is violated | The server only allows valid status changes, requires an owner before work can progress, and requires a different manager to approve. Editing the title or description after approval cancels the approval, because the approval applied to the earlier text. |
| The screen shows something the server later rejects | Claiming is shown on screen immediately. When the server answers, the screen is corrected. If the claim lost the race, the screen is restored and a message explains why. |
| Background work fails or runs twice | Details follow in the next section. |

## What happens when something fails

| Failure | Result |
|---|---|
| The server stops in the middle of an action | The change, its history entry and its background job are saved together in one transaction, so either all of them exist or none of them exist. |
| The notification code raises an error | The user's action has already succeeded. The job is retried with increasing waiting times. After five failed attempts it is marked as dead so that a developer can inspect it. |
| The background worker stops while it is working on a job | The job is leased for 30 seconds. When the lease expires, another worker takes the job. |
| The same job runs twice | A unique database index on the combination of user and event means the second run creates no duplicate notification. |
| A request is rejected after some work was done | Nothing is saved. No history entry is written and the version number does not change. An automated test checks this. |

## Data design and performance

- A work item is stored as one document that contains its current state. The history is stored in a separate collection with one document per event. The history grows without limit, and keeping it separate means that loading the list stays fast.
- Lists use cursor-based pagination. Instead of skipping a number of rows, each page continues from the last item of the previous page. This keeps page one thousand as fast as page one.
- Each list query is limited to the teams of the signed-in user, and the matching database indexes start with the team. This keeps the queries fast as the data grows.
- Counts in the sidebar come from one indexed database query.
- The browser only holds the pages the user has loaded. It never loads the whole data set.

## Interface overview

All routes begin with `/api` and require a login token, except the login route.

| Purpose | Route |
|---|---|
| Sign in | `POST /auth/login` |
| Current user and teams | `GET /me` |
| Counts for the sidebar | `GET /summary` |
| List and search items | `GET /items` (options: `view`, `team_id`, `status`, `priority`, `assignee`, `q`, `sort`, `cursor`, `limit`) |
| Create an item | `POST /items` |
| Read an item and its history | `GET /items/:id` |
| Edit an item | `PATCH /items/:id` |
| Actions on an item | `POST /items/:id/claim`, `/assign`, `/transition`, `/approval`, `/comments` |
| Team members | `GET /teams/:id/members`, and `PUT /teams/:id/members` for administrators |
| Notifications | `GET /notifications`, `POST /notifications/read` |
| Live updates | `GET /stream` |

Every action that changes data accepts an `Idempotency-Key` header. Edits, status changes, assignments and approvals must include the item `version` the client last saw. Errors are returned as JSON with an `error` code and a `message`, using the HTTP statuses 400, 401, 403, 404, 409 or 422.

## Automated tests

The 22 tests in `test/critical.test.js` cover the behaviours that would be most harmful if they were wrong:

- **Simultaneous actions.** Two and five users claiming the same item, two users editing at once, and edits made from an outdated screen.
- **Repeated requests.** Creating an item twice with the same key, three identical comment requests at once, and a rejected request that must not block its key.
- **Permissions.** Users from another team receive "not found" for every action, each role is checked, and only administrators can change team membership.
- **Workflow and approvals.** Invalid status moves, the four-eyes rule, and an approval cancelled by an edit.
- **History and consistency.** The history records who did what with the old and new values, and a rejected request leaves no partial data behind.
- **Background work.** One notification per event even when the job runs twice, retries followed by the dead state, recovery after a worker stops, and two workers competing for the same job.
- **Reading data.** Pagination without gaps or duplicates, team isolation, search, and the "Needs attention" view.

## Project structure

```
src/
  server.js      Starts the web server and the background worker
  app.js         Routes, login checks, transactions, repeated-request handling, live updates
  db.js          Database connection and indexes
  service.js     All actions and all queries
  policy.js      Roles, allowed status changes and permission rules
  outbox.js      Background worker and notification creation
  auth.js        Password hashing and signed login tokens
public/          The web interface (index.html, app.js, style.css)
scripts/seed.js  Creates the demonstration data
test/            Test helpers and the automated tests
```

## More documentation

- `ENGINEERING_DECISIONS.md` explains the main design decisions and their trade-offs.
- `KNOWN_LIMITATIONS.md` lists what is missing or simplified on purpose.

## What I would improve next

If the application had to serve many more users, I would run the background worker as a separate process, add a shared message channel so that live updates work across several servers, and move search to Atlas Search for matching word beginnings and spelling mistakes.

With another week, I would work on these items:

- Stronger login security: refreshing and revoking tokens, limiting login attempts, single sign-on and multi-factor authentication.
- Email and Slack notifications.
- Service-level deadlines for each team, with automatic escalation.
- A screen for team administrators to manage members.
- File attachments.
- Automated tests that drive the web interface in a real browser.
