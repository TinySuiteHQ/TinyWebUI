/** Tiny DOM helpers shared by every module. */

export const $ = (id) => document.getElementById(id);
export const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
export const num = (v) => (v.trim() === '' ? null : Number(v));

/** "Install uv" for a server whose launcher is missing (`install` from /api/tools). */
export const installLink = ({ name, url }) => Object.assign(el('a', 'install-link'), {
  textContent: `Install ${name}`,
  href: /^https:\/\//.test(url) ? url : '#',
  target: '_blank',
  rel: 'noopener noreferrer'
});
