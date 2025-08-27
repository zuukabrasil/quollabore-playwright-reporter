npm i -D @quollabore/playwright-reporter

// playwright.config.ts
import { QuollaboreReporter } from '@quollabore/playwright-reporter';

export default {
  reporter: [
    ['list'],
    [QuollaboreReporter] // ou [QuollaboreReporter, { projectId:'...', portalUrl:'...', token:'...' }]
  ]
};

// ENVs: Q_PORTAL_URL, Q_INGEST_TOKEN, Q_PROJECT_ID, (opcional) Q_ENV
