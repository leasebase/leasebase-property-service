import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { propertiesRouter } from './routes/properties';
import { unitsRouter } from './routes/units';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

app.use('/internal/properties', propertiesRouter);
app.use('/internal/properties', unitsRouter);

startApp(app);
