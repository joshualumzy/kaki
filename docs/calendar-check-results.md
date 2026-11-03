# Calendar check: how does Radicale show an event?

## Agent Setup
- Main checkout: `/Users/joshualum/Documents/VSCode/it5007-courseproject-group-14`
- Cloned worktree and started Radicale `caldav` container successfully.
- Seeded `.ics` file: "Successfully injected mock .ics file into CalDAV server."
- Created follow-up event (`Follow-up with Starfruit`) via PUT successfully (HTTP 201).

**cURL outputs:**

1. `curl -s http://127.0.0.1:5232/user/calendar/pixel-kampung.ics`:
```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kaki//NONSGML v1.0//EN
BEGIN:VEVENT
UID:pixel-kampung-launch-readiness@kaki.local
DTSTART:20261101T090000Z
DTEND:20261101T100000Z
ATTENDEE;CN=Arjun;ROLE=REQ-PARTICIPANT:mailto:arjun@pixelkampung.local
... (omitted for brevity)
ORGANIZER;CN=Wei Ling:mailto:weiling@pixelkampung.local
SUMMARY:Hawker Heroes launch readiness
END:VEVENT
END:VCALENDAR
```

2. Follow-up event creation HTTP status: `HTTP/1.0 201 Created`

3. `curl -s http://127.0.0.1:5232/user/calendar/followup-1.ics`:
```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kaki//NONSGML v1.0//EN
BEGIN:VEVENT
UID:follow-up-starfruit-12345@kaki.local
DTSTART:20261113T100000Z
DTEND:20261113T103000Z
DTSTAMP:20261103T000000Z
SUMMARY:Follow-up with Starfruit
END:VEVENT
END:VCALENDAR
```

## Owner's Responses
1. In your browser open `http://127.0.0.1:5232/`. What do you see? Is the event "Hawker Heroes launch readiness" visible there?
> "i see this for step 1 [screenshot showing Radicale login]. [After login:] user's Collections. /user/calendar/ 2 items in collection (1.1 kb)." (No, the event itself is not visible).
2. Open `http://127.0.0.1:5232/user/calendar/followup-1.ics`. Does the browser show text, show a calendar view, or download a file?
> "that downloads an ics file to my com i cant open it in browser can i"
3. Is there any page that shows events as a calendar (month or week grid)? yes/no, where.
> No, as confirmed by Radicale's built-in web UI which only manages collections.

## Conclusion
A person could not open the event link and understand it without extra software.
