import 'dotenv/config';
import { createClerkClient } from '@clerk/backend';
import { db } from './db';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function seed() {
  const seedUserId = process.env.SEED_USER_ID;
  if (!seedUserId) throw new Error('SEED_USER_ID env var is required');

  // Mark user as superadmin in Clerk metadata
  await clerkClient.users.updateUserMetadata(seedUserId, {
    publicMetadata: { platform_role: 'superadmin' },
  });
  console.log(`✓ Set platform_role=superadmin for user ${seedUserId}`);

  // Create a default gym
  const { rows } = await db.query(
    `INSERT INTO gyms (name, slug, plan)
     VALUES ('My Gym', 'my-gym', 'free')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
  );
  const gym = rows[0];
  console.log(`✓ Gym ready: ${gym.name} (${gym.id})`);

  // Add the seed user as admin of the default gym
  await db.query(
    `INSERT INTO gym_memberships (user_id, gym_id, role)
     VALUES ($1, $2, 'admin')
     ON CONFLICT (user_id, gym_id) DO UPDATE SET role = 'admin'`,
    [seedUserId, gym.id],
  );
  console.log(`✓ User ${seedUserId} is admin of gym ${gym.id}`);

  await db.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
