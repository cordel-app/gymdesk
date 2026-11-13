import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireRole } from '../infra/tenantContext';
import { requireFeatureEnabled } from '../infra/featureFlags';
import { getRequestLocale } from '../infra/locale';
import { listMuscles } from './exercise-muscles';

/**
 * #2333 stage 4: the muscle names the Members App shows, mounted at
 * `/me/muscles`. The `/me` exercise reads report muscles by slug; this is the
 * catalogue those slugs are labelled from, in the request's language
 * (`muscle_translations`, falling back to `muscles.name`): the same
 * `listMuscles()` the Admin exercise screens read, so both apps name a muscle
 * as Cordel → Muscles does.
 */
export const meMusclesRouter = Router();

meMusclesRouter.use(requireRole('member'), requireFeatureEnabled('training'));

meMusclesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json((await listMuscles(getRequestLocale(req))).map(({ key, display_name }) => ({ key, display_name })));
  } catch (err) { next(err); }
});
