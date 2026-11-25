/** The tools that take a username and password send them in an HTTP Basic header, never a URL. */
export function basicAuthHeaders(
  user: string | undefined,
  password: string | undefined,
): Record<string, string> {
  if (user === undefined || user === '' || password === undefined || password === '') return {};
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

/** True when a URL carries a username or password in its own text. */
export function urlHasCredentials(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

/** The plain-words refusal for credentials typed into a URL instead of their own fields. */
export function credentialsInUrlMessage(subject: string): string {
  return `Put the ${subject} username and password in their own fields, not in the URL.`;
}
