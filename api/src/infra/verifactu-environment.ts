// #2648 stage 3 — which AEAT service this deployment's invoices point at. Read
// once at boot, so an invalid value stops the API from starting instead of
// printing a wrong verification URL on an invoice.
import { parseVerifactuEnvironment, type VerifactuEnvironment } from '../domain/verifactu';

export const VERIFACTU_ENVIRONMENT: VerifactuEnvironment =
  parseVerifactuEnvironment(process.env.VERIFACTU_ENVIRONMENT);
