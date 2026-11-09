import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAPHQL_URL = 'https://ebus.tycg.gov.tw/ebus/graphql';
const SMALL_BUS_TYPE = 10;
const ROUTE_DETAIL_BATCH_SIZE = 20;
const SCHEDULE_BATCH_SIZE = 10;
const SCHEDULE_DAYS = 7;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = resolve(PROJECT_ROOT, 'official-transit-data.json');

function taipeiDateParts(date = new Date()) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(values.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function scheduleDateRange() {
  const { year, month, day } = taipeiDateParts();
  const firstDay = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return Array.from({ length: SCHEDULE_DAYS }, (_, offset) => {
    const date = new Date(firstDay);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

function makeRouteDetailQuery(batch) {
  const selections = batch.map((route, index) =>
    'r' + index + ':route(xno:' + Number(route.id) + ',lang:"zh"){id name departure destination opType description routeGroup routePoint{go back} stations{edges{orderNo goBack node{id name lat lon}}}}'
  );

  return 'query {' + selections.join(' ') + '}';
}

function makeScheduleQuery(batch, date) {
  const selections = batch.map((route, index) =>
    's' + index + ':dailySchedule(xno:' + Number(route.id) + ',date:"' + date + '"){' +
      '__typename ' +
      '... on DailyTimeTableConnection{edges{node{goBack scheduleTime}}} ' +
      '... on DailyHeadwayConnection{edges{node{goBack peakType startTime endTime upperLimit lowerLimit}}}' +
    '}'
  );

  return 'query {' + selections.join(' ') + '}';
}

async function graphql(query) {
  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30_000)
      });

      if (!response.ok) throw new Error('Official API returned HTTP ' + response.status);
      const payload = await response.json();
      if (payload.errors?.length) {
        throw new Error(payload.errors.map(error => error.message).join('; '));
      }
      return payload.data;
    }
    catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 750 * (2 ** attempt)));
      }
    }
  }

  throw lastError;
}

async function fetchRouteCatalog() {
  const catalog = await graphql('query { routes(lang:"zh") { edges { node { id seq name opType } } } }');
  return (catalog.routes?.edges || [])
    .map(edge => edge.node)
    .filter(route => Number(route.opType) === SMALL_BUS_TYPE && /^\d+$/.test(String(route.id)))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

async function fetchRouteDetails(candidates) {
  const routeDetails = new Map();

  for (let start = 0; start < candidates.length; start += ROUTE_DETAIL_BATCH_SIZE) {
    const batch = candidates.slice(start, start + ROUTE_DETAIL_BATCH_SIZE);
    const result = await graphql(makeRouteDetailQuery(batch));

    batch.forEach((route, index) => {
      const detail = result['r' + index];
      if (detail) routeDetails.set(String(route.id), detail);
    });
  }

  return routeDetails;
}

async function fetchSchedules(candidates, dates) {
  const schedulesByRoute = Object.fromEntries(candidates.map(route => [String(route.id), {}]));

  for (const date of dates) {
    for (let start = 0; start < candidates.length; start += SCHEDULE_BATCH_SIZE) {
      const batch = candidates.slice(start, start + SCHEDULE_BATCH_SIZE);
      const result = await graphql(makeScheduleQuery(batch, date));

      batch.forEach((route, index) => {
        // Keep empty or null results too, so the page knows this date was checked by the daily job.
        schedulesByRoute[String(route.id)][date] = result['s' + index] ?? null;
      });
    }
  }

  return schedulesByRoute;
}

async function main() {
  const candidates = await fetchRouteCatalog();
  if (!candidates.length) throw new Error('The official API returned no 桃小巴 routes.');

  const dates = scheduleDateRange();
  const [routeDetails, schedulesByRoute] = await Promise.all([
    fetchRouteDetails(candidates),
    fetchSchedules(candidates, dates)
  ]);
  const routes = candidates.map(route => routeDetails.get(String(route.id))).filter(Boolean);

  const snapshot = {
    source: '桃園市公車動態資訊系統',
    generatedAt: new Date().toISOString(),
    timezone: 'Asia/Taipei',
    scheduleDates: dates,
    routes,
    schedulesByRoute
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log('Wrote ' + routes.length + ' routes and schedules for ' + candidates.length + ' routes across ' + dates.length + ' dates to ' + OUTPUT_PATH);
}

main().catch(error => {
  console.error('Failed to refresh official 桃小巴 data:', error);
  process.exitCode = 1;
});
