import { describe, it, expect } from 'vitest';
import { goalRowsSql, NUTRITION_GOAL_IMAGE_JOIN_SQL } from '../api/nutrition-goal-illustration';

// #1717: a plan goal's image is the System Nutrition Goal's, resolved on read.
describe('plan goal image resolution', () => {
  it.each(['nutrition_plan_template_goals', 'member_nutrition_plan_goals'] as const)(
    'reads the goal image through the catalogue slug for %s',
    (table) => {
      const sql = goalRowsSql(table, 'g.id = ?');
      expect(sql).toContain(NUTRITION_GOAL_IMAGE_JOIN_SQL);
      expect(sql).toContain('goal_image_url');
      expect(sql).toContain('goal_image_thumbnail_url');
      // the food illustration stays available as the second source
      expect(sql).toContain('illustration_image_url');
    },
  );

  it('joins only System goals by slug and never copies an image onto the plan', () => {
    expect(NUTRITION_GOAL_IMAGE_JOIN_SQL).toContain('ng.slug = g.item_name');
    expect(NUTRITION_GOAL_IMAGE_JOIN_SQL).toContain('ng.gym_id IS NULL');
    expect(NUTRITION_GOAL_IMAGE_JOIN_SQL).toContain("ng.status <> 'deleted'");
  });
});
