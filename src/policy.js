'use strict';
// Pure functions: roles + workflow rules. Everything the API enforces is decided here,
// and the same `permissionsFor` result is sent to the UI (which only uses it to hide controls).
const RANK = { viewer: 0, member: 1, manager: 2, admin: 3 };
const atLeast = (role, min) => role != null && RANK[role] >= RANK[min];

const TRANSITIONS = {
  open: ['in_progress', 'closed'],
  in_progress: ['blocked', 'resolved', 'open'],
  blocked: ['in_progress', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: ['open'],
};
const PRIORITIES = { critical: 0, high: 1, medium: 2, low: 3 };

class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

function permissionsFor(role, item, userId) {
  if (!role) return null;
  const isMember = atLeast(role, 'member'), isMgr = atLeast(role, 'manager');
  const involved = item.assignee_id === userId || item.reporter_id === userId;
  const done = item.status === 'closed';
  const targets = (TRANSITIONS[item.status] || []).filter((to) =>
    isMgr || (isMember && item.assignee_id === userId && to !== 'closed'));
  return {
    comment: isMember,
    claim: isMember && item.assignee_id == null && !done,
    edit: !done && (isMgr || (isMember && involved)),
    assign: !done && isMgr,
    transitions: targets,
    requestApproval: !!item.approval_required && ['none', 'rejected'].includes(item.approval_status)
      && item.status === 'in_progress' && (isMgr || (isMember && involved)),
    decideApproval: !!item.approval_required && item.approval_status === 'pending'
      && isMgr && item.approval_requested_by !== userId,
  };
}
module.exports = { RANK, atLeast, TRANSITIONS, PRIORITIES, HttpError, permissionsFor };
