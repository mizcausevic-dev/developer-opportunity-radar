// Minimal JSON Schema (OpenAPI 3.1 subset) validator for contract tests. Dependency-free.
// Strict on purpose: an object schema that declares `properties` is treated as CLOSED, so a
// field the API returns but the spec doesn't document is an error. That is the drift this
// test exists to catch.

export function makeValidator(spec) {
  const resolve = (s) => {
    let cur = s;
    while (cur && cur.$ref) cur = cur.$ref.slice(2).split('/').reduce((o, k) => o[k], spec);
    return cur;
  };

  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

  // allOf parts are merged so a composed schema is still closed over the union of properties.
  const flatten = (s) => {
    s = resolve(s);
    if (!s?.allOf) return s;
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of s.allOf.map(flatten)) {
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
    }
    return merged;
  };

  function validate(schema, value, path = '$', errors = []) {
    const s = flatten(schema);
    if (!s || Object.keys(s).length === 0) return errors;
    if (s.type) {
      const types = [].concat(s.type);
      const t = typeOf(value);
      const ok = types.includes(t) || (t === 'integer' && types.includes('number'));
      if (!ok) {
        errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
        return errors;
      }
    }
    if ('const' in s && value !== s.const) errors.push(`${path}: expected const ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    if (typeof value === 'number' && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (typeof value === 'string' && s.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(`${path}: not a date-time`);
    if (typeof value === 'string' && s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match ${s.pattern}`);
    if (typeOf(value) === 'object') {
      for (const r of s.required ?? []) if (!(r in value)) errors.push(`${path}: missing required "${r}"`);
      if (s.properties) {
        for (const [k, v] of Object.entries(value)) {
          if (k in s.properties) validate(s.properties[k], v, `${path}.${k}`, errors);
          else if (s.additionalProperties !== true) errors.push(`${path}: undocumented field "${k}"`);
        }
      }
    }
    if (Array.isArray(value) && s.items) value.forEach((v, i) => validate(s.items, v, `${path}[${i}]`, errors));
    return errors;
  }

  /** Schema for a documented response, or throws if the spec doesn't document it. */
  function responseSchema(method, pathTemplate, status, contentType) {
    const op = spec.paths[pathTemplate]?.[method.toLowerCase()];
    if (!op) throw new Error(`undocumented operation ${method} ${pathTemplate}`);
    const resp = resolve(op.responses[String(status)] ?? op.responses.default);
    if (!resp) throw new Error(`undocumented status ${status} for ${method} ${pathTemplate}`);
    const media = resp.content?.[contentType.split(';')[0].trim()];
    if (!media) throw new Error(`undocumented media type ${contentType} for ${status} ${method} ${pathTemplate}`);
    return media.schema;
  }

  return { validate, responseSchema };
}
