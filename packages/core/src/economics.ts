import { bpsOfMinor } from './money';

/** Illustrative campaign contribution model (spec §8); merchants run sensitivity before launch. */
export interface EconomicsInput {
  units: number;
  offerMinor: number;
  unitCostMinor: number;
  prizesMinor: number;
  commissionBps: number;
  otherCostsMinor: number;
}
export function campaignContribution(i: EconomicsInput) {
  const gross = i.units * i.offerMinor;
  const cogs = i.units * i.unitCostMinor;
  const commission = bpsOfMinor(gross, i.commissionBps);
  const contribution = gross - cogs - i.prizesMinor - commission - i.otherCostsMinor;
  return { grossMinor: gross, cogsMinor: cogs, prizesMinor: i.prizesMinor, commissionMinor: commission, otherCostsMinor: i.otherCostsMinor, contributionMinor: contribution };
}

export function sensitivity(base: EconomicsInput, unitScenarios: number[]) {
  return unitScenarios.map((u) => ({ units: u, ...campaignContribution({ ...base, units: u }) }));
}
