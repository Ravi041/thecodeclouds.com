const blockingSeverities = new Set(['high', 'critical']);

// High and critical advisories in an `npm audit --json` report, one entry per advisory and package.
export function advisories(report) {
  const found = new Map();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities || {})) {
    for (const via of vulnerability.via || []) {
      if (typeof via !== 'object' || !blockingSeverities.has(via.severity)) continue;
      const id = via.url?.split('/').pop() || `npm-${via.source}`;
      const pkg = via.name || name;
      found.set(`${id} ${pkg}`, { id, package: pkg, severity: via.severity, title: via.title, url: via.url });
    }
  }
  return [...found.values()];
}

export function validateExceptions(exceptions) {
  if (!Array.isArray(exceptions)) throw new Error('Audit exceptions must be an array');
  for (const exception of exceptions) {
    for (const field of ['id', 'package', 'reason', 'reviewedAt', 'expiresAt']) {
      if (typeof exception[field] !== 'string' || !exception[field].trim()) throw new Error(`Audit exception missing ${field}`);
    }
    const reviewed = new Date(exception.reviewedAt);
    const expires = new Date(exception.expiresAt);
    if (!Number.isFinite(reviewed.getTime()) || !Number.isFinite(expires.getTime())) throw new Error(`Audit exception ${exception.id} has an invalid date`);
    if (expires <= reviewed) throw new Error(`Audit exception ${exception.id} must expire after its review`);
  }
  return exceptions;
}

// Splits advisories into blocking and accepted. An exception covers one advisory in one package
// until it expires; afterwards the advisory blocks again until somebody reviews it.
export function auditResult(report, exceptions, now = new Date()) {
  validateExceptions(exceptions);
  const found = advisories(report);
  const covers = (exception, advisory) => exception.id === advisory.id && exception.package === advisory.package;
  const active = exceptions.filter(exception => new Date(exception.expiresAt) > now);
  return {
    blocking: found.filter(advisory => !active.some(exception => covers(exception, advisory))),
    accepted: found.filter(advisory => active.some(exception => covers(exception, advisory))),
    expired: exceptions.filter(exception => new Date(exception.expiresAt) <= now),
    unused: active.filter(exception => !found.some(advisory => covers(exception, advisory)))
  };
}
