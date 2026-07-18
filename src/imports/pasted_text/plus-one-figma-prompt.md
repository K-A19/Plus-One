# Figma Make Prompt — Plus One (Stage Manager only)

Copy everything below into Figma Make.

---

Design a web app called **Plus One** — a solo hackathon co-pilot that lives in a narrow, full-height sidebar panel meant to be tiled next to a code editor (not a floating widget, not a popup, not always-on-top — just a normal browser window the user tiles themselves).

**Product scope for this build:** Only the "Stage Manager" mode — a logistics/checklist watcher that tracks hackathon submission requirements and interrupts the user (visually, with escalating urgency) as the deadline approaches. No other modes/personas needed.

## Visual identity
- Base palette: kraft paper, cream, and sage green — warm, minimal, calm.
- Agitated/escalated state: same layout, palette shifts toward a soft coral-pink (never harsh red, never alarming). The UI never restructures when agitated, only the color and tone shift.
- Typography: clean, slightly editorial, not corporate-SaaS. Warm and personal, like a well-designed notebook rather than a dashboard.
- Calm state should feel quiet and get out of the way; agitated state should feel like a nudge from a person, not a system alert.

## Screens to design

### 1. Login screen
- In-character but not literally talking — no mascot, no dialogue bubble.
- Personality lives in small copy details: the button label, one small aside line of text near the login button, and a subtle status-dot icon (small colored dot, calm sage by default) that hints the app has a "mood."
- Auth0-style login (email/social login button).

### 2. Sign-up / project setup screen
- Minimal form to create a user profile and register a project: project name, hackathon deadline (date + time picker), Devpost/GitHub links (optional at this stage).
- This is the screen that establishes the countdown clock the whole app runs on.

### 3. Main dashboard (the split-screen sidebar)
- Full-height, narrow vertical panel (assume roughly 380–420px wide, full viewport height) — designed to sit tiled beside a code editor window, not centered on a big desktop layout.
- Top: countdown / time-remaining, prominent but not shouty.
- Checklist, split into two sections:
  - **Essentials** (system-generated, from Devpost submission requirements): Devpost submission created, GitHub repo public, README exists (not a placeholder), demo video link resolves, submitted to correct prize track(s). Each item has a done/not-done toggle and a small automated/manual indicator (e.g. small icon distinguishing "we checked this for you" vs "mark this yourself").
  - **Added by you**: user's own custom checklist items.
- Add-item row: a text input and a mic button side by side, so items can be typed or spoken.
- A small persistent status area showing the last "check-in" — e.g. "Last check: 2 minutes ago."
- A manual "how am I doing?" button that forces an on-demand status readout/interrupt.

### 4. Calm state
- Quiet, minimal, kraft/cream/sage. Checklist items sit calmly, countdown is understated. Nothing pulses or demands attention.

### 5. Agitated/escalated state
- Same exact layout as the calm dashboard — no new UI elements, no modal takeover.
- Palette shifts to soft coral-pink accents (background wash, checklist highlights, or accent border — designer's call, but keep it soft, not alarming).
- A short interrupt message appears in a consistent location (e.g. top of panel, above the countdown) — this is where Gemini-generated urgency copy will be injected, so leave a clear text slot with room for 1–2 sentences.
- Include a version showing a mid-severity state and a version showing a high-severity state, so the escalation gradient (calm → mid → high) is visually legible as a spectrum, not just two extremes.

### 6. Browser tab / favicon detail (optional, note only)
- Note in your design notes that the browser tab title is dynamic (e.g. "Plus One — 40m left") — no separate screen needed, just flag it as a implementation detail so it's not forgotten.

## Interaction notes
- Design for a 36-hour hackathon context: the person using this app is tired, checking it out of the corner of their eye, and needs to parse status at a glance.
- Prioritize glanceability over information density — favor whitespace and clear state over cramming in detail.
- The checklist is the hero element of the screen; the countdown and interrupt banner support it, they don't compete with it.

## Deliverable
Produce: login screen, sign-up/project-setup screen, dashboard in calm state, dashboard in mid-escalation state, dashboard in high-escalation state. Keep all five as one consistent component system (same panel width, same checklist component, same typography) so they read as one product.

## Backend / integrations
Add a real backend using your built-in Supabase integration: user sign-in for the login screen, and storage for the checklist state, interrupt log, and last check-in timestamp.

Also wire up calls to these external services, using stored secrets/API keys for each:
- Gemini API — for generating escalation tone/urgency copy
- ElevenLabs — for spoken interrupts
- GitHub API — for checking repo-public and README-exists status (needs a personal access token)

Before building any of this, **ask me for whatever credentials, keys, or config values you need for each of these** (e.g. Gemini API key, ElevenLabs API key + voice ID, GitHub personal access token, any Supabase project details) rather than assuming or stubbing them in. Ask one integration at a time if that's easier, and tell me exactly what you need for each.