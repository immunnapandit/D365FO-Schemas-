import express from 'express';

/**
 * A fake "F&O + Entra ID" server used by the tests.
 *  POST /tenant/oauth2/v2.0/token   -> client credentials (secret must be "good")
 *  POST /data/SalesOrderHeadersV2   -> 201, or F&O style 500 when customer is "BAD"
 *  GET  /data/Flaky                 -> 503 once, then 200 (retry test)
 */
export async function startUpstream() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const state = { tokenCalls: 0, tokenSeq: 0, revoked: new Set(), flaky: 0, lastBody: null, lastHeaders: null };

  // no sign-in: records the body as received, for body-shape tests
  app.post('/echo', (req, res) => {
    state.lastBody = req.body;
    state.lastQuery = req.query;
    res.json({ ok: true });
  });
  app.post('/tenant/oauth2/v2.0/token', (req, res) => {
    state.tokenCalls += 1;
    if (req.body.grant_type === 'password') {
      state.lastTokenRequest = req.body;
      if (req.body.username !== 'svc-user' || req.body.password !== 'svc-pass') {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'AADSTS50126: Invalid username or password.' });
      }
    } else if (req.body.client_secret !== 'good') {
      return res.status(401).json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
    }
    state.tokenSeq += 1;
    res.json({ token_type: 'Bearer', expires_in: 3599, access_token: `tok-${state.tokenSeq}` });
  });

  const authed = (req, res, next) => {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    if (!t.startsWith('tok-') || state.revoked.has(t)) return res.status(401).json({ error: { message: 'Unauthorized' } });
    next();
  };

  app.post('/data/SalesOrderHeadersV2', authed, (req, res) => {
    state.lastBody = req.body;
    state.lastHeaders = req.headers;
    if (req.body.OrderingCustomerAccountNumber === 'BAD') {
      return res.status(500).json({
        error: {
          code: '',
          message: 'An error has occurred.',
          innererror: {
            message: "Write failed for table row of type 'SalesOrderHeaderV2Entity'. Infolog: Error: Customer BAD does not exist.",
            type: 'Microsoft.Dynamics.Platform.Integration.Services.OData.AxODataWriteException',
            internalexception: { message: 'Customer BAD does not exist.' },
          },
        },
      });
    }
    res.status(201).json({ ...req.body, SalesOrderNumber: '001234' });
  });

  // sales order lines: item "BAD" fails like F&O
  state.lines = [];
  app.post('/data/SalesOrderLines', authed, (req, res) => {
    if (req.body.ItemNumber === 'BAD') {
      return res.status(500).json({ error: { message: 'An error has occurred.', innererror: { message: 'Item number BAD does not exist.' } } });
    }
    state.lines.push(req.body);
    res.status(201).json({ ...req.body, LineCreationSequenceNumber: state.lines.length });
  });
  // OData list: records what the query asked for
  app.get('/data/CustomersV3', authed, (req, res) => {
    state.lastQuery = req.query;
    state.lastUrl = req.originalUrl;
    res.json({ '@odata.count': 2, value: [{ dataAreaId: 'usmf', CustomerAccount: 'US-001' }, { dataAreaId: 'usmf', CustomerAccount: 'US-002' }] });
  });

  app.get('/data/Flaky', authed, (_req, res) => {
    state.flaky += 1;
    if (state.flaky === 1) return res.status(503).set('Retry-After', '0').json({ error: { message: 'busy' } });
    res.json({ value: [1, 2, 3] });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: () => new Promise((r) => server.close(r)) };
}

export function salesOrderDefinition(upstreamUrl, overrides = {}) {
  return {
    name: 'Test Sales Order',
    icon: 'cart',
    category: 'Sales and marketing',
    auth: {
      type: 'oauth2_client_credentials',
      tokenUrl: `${upstreamUrl}/tenant/oauth2/v2.0/token`,
      clientId: 'cid',
      clientSecret: 'good',
      scope: 'https://fno.example/.default',
    },
    api: {
      method: 'POST',
      url: `${upstreamUrl}/data/SalesOrderHeadersV2`,
      bodyTemplate: {
        dataAreaId: '{{form.dataAreaId | lower}}',
        OrderingCustomerAccountNumber: '{{form.customer}}',
        RequestedReceiptDate: '{{form.date | datetime}}',
      },
      successMessage: 'Sales order {{response.SalesOrderNumber}} created.',
    },
    formSchema: {
      type: 'object',
      required: ['dataAreaId', 'customer'],
      properties: {
        dataAreaId: { type: 'string', default: 'usmf' },
        customer: { type: 'string' },
        date: { type: 'string', format: 'date' },
      },
    },
    ...overrides,
  };
}
