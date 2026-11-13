// Generated identities last for the lifetime of this tab, including reloads
// and room navigation. Explicitly saved profile choices remain in localStorage.
export function sessionProfile(local, session, generateName, generateColor) {
  const name = local.getItem('cbw-name') || session.getItem('cbw-session-name') || generateName();
  const color = local.getItem('cbw-color') || session.getItem('cbw-session-color') || generateColor();
  session.setItem('cbw-session-name', name);
  session.setItem('cbw-session-color', color);
  return { name, color };
}
