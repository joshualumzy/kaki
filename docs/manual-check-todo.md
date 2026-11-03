# Manual Delegation Check - Owner Checklist

The environment is clean and ready. The replay has finished successfully. 

### "Before" State Facts
* **Mailpit message count:** 6
* **Newest Gitea issue number:** 9 ("kaki-prep-check")
* **Newest Mattermost post:** "kaki-prep-check" at 2026-11-03T14:32:50.993Z

### Setup Info
* The main dev server is running on `http://localhost:5173/` (Vite) and `http://localhost:3001` (backend).
* You do **not** need to start another server, they are currently running in the background.
* The browser tabs have been automatically opened for you.

---

### Your Checklist

1. On the [Shared Screen](http://localhost:5173/screen), pick three **Suggested** tasks and press **"Dispatch"** for each:
   * **One that should become a Gitea issue** (e.g., *"File bug ticket for ten-customer crash"* assigned to Lead Programmer).
   * **One that should become a Mattermost post** (e.g., *"Send publisher milestone report"* or similar task assigned to Producer).
   * **One that should become an email** (e.g., *"Email a streamer about playing Hawker Heroes"* assigned to Marketing Lead).
   
2. On each assignee's phone view:
   * Go to the tab corresponding to the assigned role (e.g., [Lead Programmer / arjun](http://localhost:5173/phone?role=arjun), [Producer / weiling](http://localhost:5173/phone?role=weiling), [Marketing Lead / daniel](http://localhost:5173/phone?role=daniel)).
   * Click **"Let Kaki do it"**.
   * Wait for the draft to generate (this can take up to ~60s).
   * **Change at least one word** in the draft text.
   * Click **"Approve"**.

3. For each of the three tasks, take note of the following:
   * **The draft text:** Does it say *only* what was discussed in the meeting?
   * **The final status.**
   * **Click the provided link:** Does it successfully open the real issue, post, or email?

4. **Reporting Issues:**
   * If anything fails or reads confusingly, please copy the text exactly and let me know.

When you are finished, just reply to me saying you are done! I will then verify the "after" state through the APIs.