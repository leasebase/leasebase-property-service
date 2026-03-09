import { createApp, startApp, checkDbConnection } from '@leasebase/service-common';
import { propertiesRouter } from './routes/properties';
import { unitsRouter } from './routes/units';
import { pmDashboardRouter } from './routes/pm-dashboard';
import { pmRoutesRouter } from './routes/pm-routes';

const app = createApp({
  healthChecks: [{ name: 'database', check: checkDbConnection }],
});

app.use('/internal/properties', propertiesRouter);
app.use('/internal/properties', unitsRouter);
app.use('/internal/pm', pmDashboardRouter);
app.use('/internal/pm', pmRoutesRouter);

startApp(app);
