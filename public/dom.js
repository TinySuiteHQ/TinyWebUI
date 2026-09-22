/** Tiny DOM helpers shared by every module. */

export const $ = (id) => document.getElementById(id);
export const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
export const num = (v) => (v.trim() === '' ? null : Number(v));
