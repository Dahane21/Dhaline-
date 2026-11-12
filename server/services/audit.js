'use strict';
const { nowIso } = require('../db');

function audit(db, ctx, action, entity, entityId, detail) {
  db.insert('audit_log', {
    at: nowIso(), user_id: ctx.user?.id ?? null, username: ctx.user?.username ?? 'sistema',
    action, entity, entity_id: entityId ?? null, detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 8000),
  });
}
module.exports = { audit };
