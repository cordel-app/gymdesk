// #2648 stage 3 — which AEAT service this deployment's invoices point at. Read
// once at boot, so an invalid value stops the API from starting instead of
// printing a wrong verification URL on an invoice.
//
// #2648 stage 4 — the software (SIF) identification every submitted record
// carries in SistemaInformatico. It is the producer's (the company that makes
// and declares this software), the same for every gym, so it is deployment
// configuration and never a gym setting. Unlike the service it is not refused
// at boot: a deployment that has not declared it simply submits nothing, and
// the submission pass reports `software_not_configured`.
import { parseVerifactuEnvironment, type VerifactuEnvironment } from '../domain/verifactu';
import type { VerifactuSoftware } from '../domain/verifactuXml';

export const VERIFACTU_ENVIRONMENT: VerifactuEnvironment =
  parseVerifactuEnvironment(process.env.VERIFACTU_ENVIRONMENT);

/** The SistemaInformatico block, or null when any of its five values is unset. */
export function verifactuSoftwareFromEnv(env: NodeJS.ProcessEnv = process.env): VerifactuSoftware | null {
  const v = (k: string) => (env[k] ?? '').trim();
  const software = {
    producerName: v('VERIFACTU_SOFTWARE_PRODUCER_NAME'),
    producerNif: v('VERIFACTU_SOFTWARE_PRODUCER_NIF').toUpperCase(),
    name: v('VERIFACTU_SOFTWARE_NAME'),
    id: v('VERIFACTU_SOFTWARE_ID'),
    version: v('VERIFACTU_SOFTWARE_VERSION'),
  };
  return Object.values(software).every((x) => x !== '') ? software : null;
}
