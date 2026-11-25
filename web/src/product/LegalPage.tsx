import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../ui';
import './product.css';

const UPDATED = '25 November 2026';

/** The shared frame for the plain-language Privacy and Terms pages. */
function LegalFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page product-page product-page-narrow legal-page">
      <p className="legal-back">
        <Link className="product-link" to="/">
          ← Kaki
        </Link>
      </p>
      <article className="card legal-doc">
        <h1>{title}</h1>
        <p className="product-hint">Last updated {UPDATED}</p>
        {children}
      </article>
    </main>
  );
}

/** What Kaki stores and who processes it, written from what the code actually does. */
export function PrivacyPage() {
  useDocumentTitle('Privacy · Kaki');
  return (
    <LegalFrame title="Privacy">
      <p>
        Kaki is a meeting assistant. This page explains what Kaki stores, who processes it, how long
        it is kept, and how to delete it.
      </p>

      <h2>Signing in</h2>
      <p>
        Kaki uses Google sign-in only. When you sign in, Google confirms who you are, and Kaki
        receives your name, email address and profile photo. Kaki never sees your Google password
        and asks Google for nothing else.
      </p>
      <p>
        Your first sign-in creates your account and a personal workspace. Kaki keeps its own account
        and session records, and a session cookie keeps you signed in for 12 hours.
      </p>
      <p>
        A guest joins a meeting from its link without an account, using only the name they type. A
        guest&apos;s session is tied to that one meeting.
      </p>

      <h2>What Kaki stores</h2>
      <p>Everything below belongs to your account or to the workspace a meeting was held in.</p>
      <ul>
        <li>
          <strong>Your account:</strong> your name, email address, profile photo, Google account id
          and sign-in session records.
        </li>
        <li>
          <strong>Workspaces:</strong> the workspace name, its people and their roles, its invite
          link, and the meetings held in it.
        </li>
        <li>
          <strong>Meetings:</strong> the title, agenda and timings; the live transcript, which is
          each person&apos;s spoken words with the speaker and time and which appears in the
          minutes; the open questions Kaki finds; its notes; and every to-do and draft. When a
          meeting ends, the minutes and to-dos stay in the workspace history.
        </li>
        <li>
          <strong>Off the record:</strong> while it is on, Kaki does not transcribe, analyse or store
          the room&apos;s words. The minutes show only when it was on.
        </li>
        <li>
          <strong>The search index:</strong> Kaki reads records from the tools a workspace connects
          (Gitea, Mattermost, the mail inbox and Wiki.js) and its own company records, plus the
          minutes of ended meetings. It splits them into chunks and stores the chunks with
          embeddings in its database so the Wingman can search them.
        </li>
        <li>
          <strong>Tool logins:</strong> a workspace&apos;s tool logins are encrypted in the database
          and are never sent back to the browser. Anyone in the workspace sees only the non-secret
          settings.
        </li>
        <li>
          <strong>Meeting audio and video:</strong> in normal use, Kaki does not record or keep them.
          Live audio and video are streamed through the meeting server, and each person&apos;s speech
          is sent to Azure Speech to be turned into text. Only the text is kept.
        </li>
      </ul>

      <h2>Who processes it</h2>
      <p>
        Kaki does not sell your data, show ads, or run analytics or advertising trackers. These are
        the outside services it uses.
      </p>
      <ul>
        <li>
          <strong>Microsoft Azure (Southeast Asia)</strong> hosts Kaki, its Postgres database and the
          meeting audio and video server, and provides Azure Speech, which turns speech into text
          and produces the AI voices. Azure therefore handles stored meeting data and live meeting
          audio.
        </li>
        <li>
          <strong>The NUS School of Computing AI gateway</strong> receives meeting text (transcripts,
          notes, questions, to-dos and drafts), the text of company records and the questions you
          ask, so it can write notes, answer questions and make search embeddings.
        </li>
        <li>
          <strong>DeepSeek</strong> receives the same written requests only when the NUS gateway
          fails and Kaki falls back to it.
        </li>
        <li>
          <strong>Google</strong> handles sign-in. It also serves your profile photo and the fonts
          the page uses, so it sees the usual request details, such as your IP address.
        </li>
        <li>
          <strong>Your team&apos;s tools.</strong> Approved issues, posts, emails, wiki pages and
          calendar events go to the tools your workspace connects. In the default setup these run on
          the same server as Kaki. If an admin points a connection at another provider, that
          provider receives what Kaki writes there.
        </li>
      </ul>

      <h2>How long Kaki keeps it</h2>
      <p>
        Meetings, minutes and to-dos stay in their workspace until that workspace is deleted. A
        meeting you scheduled but have not started can be cancelled, which deletes it. Deleting a
        workspace removes its meetings, minutes, to-dos, tool logins and search-index entries
        straight away.
      </p>
      <p>
        Deleting your account ends your open meetings, then removes the workspaces where you are the
        last member, their meetings and everything in them, your practice meetings, your
        memberships, your sessions and your account in one database transaction. A team workspace
        with other members stays, and meetings you opened there stay with the workspace. There is no
        waiting period in the app. A nightly backup can still hold a copy for up to 7 days, and log
        lines for up to 30 days.
      </p>
      <p>
        A signed-out practice meeting is not kept: it exists only in the server&apos;s memory and
        goes when the room is unloaded or the server restarts. A signed-in person&apos;s practice
        meeting is kept in their own workspace history until they delete it.
      </p>
      <p>
        An action Kaki has already written to your team&apos;s tools (a Gitea issue, a Mattermost
        post, an email, a wiki page or a calendar event) stays in that tool. Deleting your account
        does not remove it.
      </p>

      <h2>Logs and backups</h2>
      <p>
        The server keeps logs so the team can investigate problems. Those logs can contain meeting
        text, such as recognised speech, Kaki&apos;s replies, notes and task titles. Kaki keeps logs
        for up to 30 days and then removes them.
      </p>
      <p>
        Kaki also backs up its database every night. Each backup is a compressed copy that only the
        machine&apos;s administrator can read, and Kaki removes backups older than 7 days. A
        backup can therefore hold deleted meeting text for up to 7 days.
      </p>
      <p>
        Deleting a meeting, workspace or account removes it from the app at once. Copies can stay in
        logs for up to 30 days and in backups for up to 7 days before they are removed.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Anyone in a meeting can turn on Off the record.</li>
        <li>
          A workspace admin can disconnect a tool, which deletes its stored login and the records
          Kaki read from it.
        </li>
        <li>You can delete your account in the account menu by typing DELETE to confirm.</li>
        <li>Guests need no account and keep none.</li>
      </ul>

      <h2>Contact</h2>
      <p>Contact: <a href="mailto:joshua.lum@u.nus.edu">joshua.lum@u.nus.edu</a> or <a href="mailto:xiao_xiao@u.nus.edu">xiao_xiao@u.nus.edu</a></p>
    </LegalFrame>
  );
}

/** The plain-language agreement for using Kaki. */
export function TermsPage() {
  useDocumentTitle('Terms · Kaki');
  return (
    <LegalFrame title="Terms">
      <p>
        These terms are a plain-language agreement for using Kaki. By signing in or joining a
        meeting, you agree to them.
      </p>

      <h2>What Kaki does</h2>
      <p>
        Kaki helps a team run a meeting. It keeps the agenda, writes notes and minutes, answers
        questions privately, and drafts follow-up work such as an issue, post, email, wiki page or
        calendar event.
      </p>
      <p>
        Kaki uses AI, so its notes, answers and drafts can be wrong or incomplete. A person reviews
        and approves every draft before it is written to a team tool, and you should check the
        minutes before relying on them.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with Google. Keep your Google account secure, because anything done through your
        signed-in Kaki account is treated as yours. You can delete your account at any time from the
        account menu.
      </p>
      <p>A guest joins with a name only and has no account.</p>

      <h2>Using Kaki fairly</h2>
      <ul>
        <li>
          Do not use Kaki to break the law, harass or deceive people, or share content you have no
          right to share.
        </li>
        <li>
          Record or transcribe only people who know the meeting is being transcribed. Kaki tells
          everyone in the room that it transcribes the meeting and offers Off the record.
        </li>
        <li>
          Do not try to reach another person&apos;s meeting, seat or workspace, or probe, overload or
          disrupt the service.
        </li>
        <li>Do not use a connected mail server to send spam or unlawful email.</li>
      </ul>

      <h2>Your content</h2>
      <p>
        You keep the content you and your team put into Kaki. You give Kaki permission to store and
        process it, and to send it to the services listed on the Privacy page, so it can run the
        meeting features.
      </p>
      <p>
        Content written to a connected tool is governed by that tool&apos;s own terms.
      </p>

      <h2>Availability and changes</h2>
      <p>
        Kaki is provided as it is. It may be changed, paused or unavailable, and no particular
        result or uptime is promised.
      </p>
      <p>Access may be ended if these terms are broken or if keeping the service safe requires it.</p>
      <p>
        These terms may be updated. The date at the top changes, and continuing to use Kaki means
        you accept the new terms.
      </p>

      <h2>Open source</h2>
      <p>
        Kaki&apos;s code is released under the GNU Affero General Public License v3.0. These terms
        cover the hosted service, not the licence for the code.
      </p>

      <h2>Contact</h2>
      <p>Contact: <a href="mailto:joshua.lum@u.nus.edu">joshua.lum@u.nus.edu</a> or <a href="mailto:xiao_xiao@u.nus.edu">xiao_xiao@u.nus.edu</a></p>
    </LegalFrame>
  );
}
