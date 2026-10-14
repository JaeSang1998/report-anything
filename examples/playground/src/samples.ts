import type { Row } from "@report-anything/core";

/** Deterministic PRNG so samples (and screenshots) are stable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const iso = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** Monthly revenue by region × channel, Jan 2025 – Jun 2026 (270 rows). Online grows fastest; Partner margins are thinnest. */
export function salesRows(): Row[] {
  const rand = rng(42);
  const regions = ["North America", "Europe", "Asia Pacific", "Latin America", "Middle East"];
  const channels = ["Online", "Retail", "Partner"];
  const rows: Row[] = [];
  for (let m = 0; m < 18; m++) {
    const month = m % 12;
    regions.forEach((region, ri) => {
      channels.forEach((channel, ci) => {
        const base = [4.2, 3.1, 2.4, 1.1, 0.7][ri]! * [1.3, 1, 0.6][ci]! * 1e5;
        const trend = 1 + m * (ci === 0 ? 0.03 : ri === 2 ? 0.02 : 0.01);
        const season = 1 + 0.12 * Math.sin(((month + 1) / 12) * Math.PI * 2);
        const revenue = Math.round(base * trend * season * (0.9 + rand() * 0.2));
        rows.push({
          month: iso(2025 + Math.floor(m / 12), month),
          region,
          channel,
          revenue,
          cost: Math.round(revenue * (0.56 + rand() * 0.06 + (ci === 2 ? 0.08 : 0) - (ci === 0 ? 0.04 : 0))),
          orders: Math.round(revenue / (ci === 2 ? 2400 : 85)),
        });
      });
    });
  }
  return rows;
}

/** SaaS subscriptions by plan, Oct 2024 – Sep 2026 (72 rows). Pro drives growth; Starter churns; Enterprise expands. */
export function saasRows(): Row[] {
  const rand = rng(11);
  const plans = [
    { plan: "Starter", price: 49, customers: 820, growth: 0.045, churn: 0.052, expansion: 0.004 },
    { plan: "Pro", price: 199, customers: 310, growth: 0.06, churn: 0.021, expansion: 0.018 },
    { plan: "Enterprise", price: 1500, customers: 24, growth: 0.035, churn: 0.006, expansion: 0.031 },
  ];
  const rows: Row[] = [];
  for (const p of plans) {
    let customers = p.customers;
    let mrr = customers * p.price;
    for (let m = 0; m < 24; m++) {
      const churnRate = p.churn * (0.8 + rand() * 0.4) * (p.plan === "Starter" && m > 15 ? 1.25 : 1);
      const lost = Math.round(customers * churnRate);
      const added = Math.round(customers * (p.growth + churnRate) * (0.85 + rand() * 0.3));
      const churned = Math.round(lost * p.price * (0.9 + rand() * 0.2));
      const expansion = Math.round(mrr * p.expansion * (0.7 + rand() * 0.6));
      const added_mrr = added * p.price;
      customers += added - lost;
      mrr += added_mrr + expansion - churned;
      rows.push({
        month: iso(2024 + Math.floor((9 + m) / 12), (9 + m) % 12),
        plan: p.plan,
        customers,
        mrr,
        new_mrr: added_mrr,
        expansion_mrr: expansion,
        churned_mrr: churned,
        logo_churn_rate: Math.round(churnRate * 10000) / 10000,
      });
    }
  }
  return rows;
}

/** Weekly web traffic by channel × device as CSV, 26 weeks from Apr 6 2026 (260 rows). Email converts best; mobile share rises. */
export function trafficCsv(): string {
  const rand = rng(5);
  const channels = [
    { name: "Organic search", sessions: 21000, cr: 0.021 },
    { name: "Paid search", sessions: 9500, cr: 0.034 },
    { name: "Social", sessions: 12000, cr: 0.009 },
    { name: "Email", sessions: 4200, cr: 0.058 },
    { name: "Referral", sessions: 3100, cr: 0.027 },
  ];
  const lines = ["week,channel,device,sessions,signups"];
  for (let w = 0; w < 26; w++) {
    const week = iso(2026, 3, 6 + w * 7);
    for (const c of channels) {
      const mobileShare = 0.48 + w * 0.006;
      for (const device of ["Desktop", "Mobile"]) {
        const share = device === "Mobile" ? mobileShare : 1 - mobileShare;
        const sessions = Math.round(c.sessions * share * (1 + w * 0.012) * (0.9 + rand() * 0.2));
        const cr = c.cr * (device === "Mobile" ? 0.72 : 1.15) * (0.85 + rand() * 0.3);
        lines.push(`${week},${c.name},${device},${sessions},${Math.round(sessions * cr)}`);
      }
    }
  }
  return lines.join("\n");
}

/** Support tickets, Jul – Sep 2026 (360 rows). Integrations are slow to resolve; phone CSAT is highest. */
export function ticketRows(): Row[] {
  const rand = rng(23);
  const categories = [
    { name: "Billing", weight: 0.24, hours: 6 },
    { name: "Login & access", weight: 0.22, hours: 3 },
    { name: "Bug", weight: 0.26, hours: 30 },
    { name: "Integrations", weight: 0.14, hours: 52 },
    { name: "Feature request", weight: 0.14, hours: 70 },
  ];
  const priorities = [
    { name: "P1", weight: 0.06, speed: 0.25 },
    { name: "P2", weight: 0.2, speed: 0.55 },
    { name: "P3", weight: 0.5, speed: 1 },
    { name: "P4", weight: 0.24, speed: 1.6 },
  ];
  const channels = [
    { name: "Email", weight: 0.5, csat: -0.35 },
    { name: "Chat", weight: 0.38, csat: 0.1 },
    { name: "Phone", weight: 0.12, csat: 0.4 },
  ];
  const pick = <T extends { weight: number }>(list: T[]): T => {
    let r = rand();
    for (const item of list) if ((r -= item.weight) <= 0) return item;
    return list[list.length - 1]!;
  };
  return Array.from({ length: 360 }, (_, i) => {
    const day = Math.floor((i / 360) * 92);
    const created = new Date(Date.UTC(2026, 6, 1 + day, 8 + Math.floor(rand() * 10), Math.floor(rand() * 60)));
    const category = pick(categories);
    const priority = pick(priorities);
    const channel = pick(channels);
    // Resolution got faster over the quarter except for integrations.
    const improvement = category.name === "Integrations" ? 1 : 1 - (day / 92) * 0.3;
    const resolution = Math.round(category.hours * priority.speed * improvement * (0.5 + rand()) * 10) / 10;
    const open = day > 80 && rand() < 0.35;
    const csat = open ? null : Math.max(1, Math.min(5, Math.round(4.2 + channel.csat - resolution / 60 + (rand() - 0.5) * 1.6)));
    return {
      id: `T-${4100 + i}`,
      created_at: created.toISOString(),
      priority: priority.name,
      category: category.name,
      channel: channel.name,
      first_response_minutes: Math.round((channel.name === "Email" ? 190 : channel.name === "Chat" ? 6 : 2) * priority.speed * (0.5 + rand())),
      resolution_hours: open ? null : resolution,
      csat,
      status: open ? "open" : "resolved",
    };
  });
}

/** A paginated orders API response with nested customers and line items (120 orders). */
export function ordersPayload(): unknown {
  const rand = rng(7);
  const tiers = ["gold", "silver", "bronze"];
  const countries = ["US", "DE", "JP", "BR"];
  const skus = [
    { sku: "PRO-01", price: 129 },
    { sku: "STD-02", price: 59 },
    { sku: "LITE-03", price: 19 },
    { sku: "ADD-04", price: 9 },
  ];
  const orders = Array.from({ length: 120 }, (_, i) => {
    const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
      const p = skus[Math.floor(rand() * skus.length)]!;
      return { sku: p.sku, qty: 1 + Math.floor(rand() * 4), price: p.price };
    });
    const day = 1 + Math.floor((i / 120) * 180);
    return {
      id: `ord_${1000 + i}`,
      created_at: new Date(Date.UTC(2026, 0, day)).toISOString(),
      status: rand() > 0.12 ? "paid" : "refunded",
      customer: { name: `Customer ${i % 37}`, tier: tiers[Math.floor(rand() * 3)], country: countries[Math.floor(rand() * 4)] },
      items,
      total: items.reduce((s, it) => s + it.qty * it.price, 0),
    };
  });
  return { meta: { page: 1, total: orders.length }, data: { orders } };
}
