import swaggerJsdoc from 'swagger-jsdoc';

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Gymdesk API',
      version: '1.0.0',
      description: 'Gym Management SaaS — backoffice REST API',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local' },
      { url: 'http://87.106.124.190:3000', description: 'Production' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Clerk session token',
        },
      },
      parameters: {
        gymId: {
          in: 'header',
          name: 'x-gym-id',
          required: true,
          schema: { type: 'string', format: 'uuid' },
          description: 'Active gym UUID',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        Gym: {
          type: 'object',
          properties: {
            id:         { type: 'string', format: 'uuid' },
            name:       { type: 'string' },
            slug:       { type: 'string' },
            plan:       { type: 'string', enum: ['free', 'pro'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Membership: {
          type: 'object',
          properties: {
            id:         { type: 'integer' },
            user_id:    { type: 'string' },
            gym_id:     { type: 'string', format: 'uuid' },
            role:       { type: 'string', enum: ['admin', 'coach', 'staff'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Member: {
          type: 'object',
          properties: {
            id:         { type: 'integer' },
            gym_id:     { type: 'string', format: 'uuid' },
            name:       { type: 'string' },
            email:      { type: 'string', format: 'email' },
            phone:      { type: 'string', nullable: true },
            deleted_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Class: {
          type: 'object',
          properties: {
            id:          { type: 'integer' },
            gym_id:      { type: 'string', format: 'uuid' },
            name:        { type: 'string' },
            description: { type: 'string', nullable: true },
            capacity:    { type: 'integer' },
            starts_at:   { type: 'string', format: 'date-time' },
            ends_at:     { type: 'string', format: 'date-time' },
            created_at:  { type: 'string', format: 'date-time' },
          },
        },
        Booking: {
          type: 'object',
          properties: {
            id:         { type: 'integer' },
            gym_id:     { type: 'string', format: 'uuid' },
            member_id:  { type: 'integer' },
            class_id:   { type: 'integer' },
            status:     { type: 'string', enum: ['confirmed', 'cancelled'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Subscription: {
          type: 'object',
          properties: {
            id:         { type: 'integer' },
            gym_id:     { type: 'string', format: 'uuid' },
            member_id:  { type: 'integer' },
            plan:       { type: 'string' },
            starts_at:  { type: 'string', format: 'date' },
            ends_at:    { type: 'string', format: 'date', nullable: true },
            status:     { type: 'string', enum: ['active', 'cancelled', 'expired'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Health' },
      { name: 'Gyms' },
      { name: 'Platform', description: 'Superadmin only' },
      { name: 'Members' },
      { name: 'Classes' },
      { name: 'Bookings' },
      { name: 'Subscriptions' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          security: [],
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } } } },
        },
      },
      '/gyms': {
        get: {
          tags: ['Gyms'],
          summary: "List authenticated user's gyms",
          responses: {
            '200': { description: 'List of gyms with role', content: { 'application/json': { schema: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/Gym' }, { type: 'object', properties: { role: { type: 'string' } } }] } } } } },
          },
        },
      },
      '/gyms/{gymId}/memberships': {
        get: {
          tags: ['Gyms'],
          summary: 'List memberships for a gym',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'List of memberships', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Membership' } } } } },
          },
        },
        post: {
          tags: ['Gyms'],
          summary: 'Add a member to a gym (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_id', 'role'], properties: { user_id: { type: 'string' }, role: { type: 'string', enum: ['admin', 'coach', 'staff'] } } } } } },
          responses: {
            '201': { description: 'Membership created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Membership' } } } },
            '409': { description: 'User already a member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
      '/gyms/{gymId}/memberships/{userId}': {
        delete: {
          tags: ['Gyms'],
          summary: 'Remove a member from a gym (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }, { in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'Removed' }, '404': { description: 'Not found' } },
        },
      },
      '/platform/gyms': {
        get: {
          tags: ['Platform'],
          summary: 'List all gyms (superadmin)',
          responses: { '200': { description: 'All gyms', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Gym' } } } } } },
        },
        post: {
          tags: ['Platform'],
          summary: 'Create a gym (superadmin)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'slug'], properties: { name: { type: 'string' }, slug: { type: 'string' }, plan: { type: 'string', enum: ['free', 'pro'] } } } } } },
          responses: {
            '201': { description: 'Gym created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Gym' } } } },
            '409': { description: 'Slug already taken' },
          },
        },
      },
      '/platform/gyms/{gymId}/admins': {
        post: {
          tags: ['Platform'],
          summary: 'Assign a gym admin (superadmin)',
          parameters: [{ in: 'path', name: 'gymId', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string' } } } } } },
          responses: { '201': { description: 'Admin assigned', content: { 'application/json': { schema: { $ref: '#/components/schemas/Membership' } } } } },
        },
      },
      '/members': {
        get: {
          tags: ['Members'],
          summary: 'List active members',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Members list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Member' } } } } } },
        },
        post: {
          tags: ['Members'],
          summary: 'Create a member (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, phone: { type: 'string' } } } } } },
          responses: { '201': { description: 'Member created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Member' } } } } },
        },
      },
      '/members/count': {
        get: {
          tags: ['Members'],
          summary: 'Count active members',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Count', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } } } },
        },
      },
      '/members/deleted': {
        get: {
          tags: ['Members'],
          summary: 'List soft-deleted members',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Deleted members', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Member' } } } } } },
        },
      },
      '/members/{id}': {
        get: {
          tags: ['Members'],
          summary: 'Get a member',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Member' } } } }, '404': { description: 'Not found' } },
        },
        put: {
          tags: ['Members'],
          summary: 'Update a member (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } } } } },
          responses: { '200': { description: 'Updated member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Member' } } } }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Members'],
          summary: 'Soft-delete a member (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },
      '/members/{id}/restore': {
        post: {
          tags: ['Members'],
          summary: 'Restore a soft-deleted member (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Restored member', content: { 'application/json': { schema: { $ref: '#/components/schemas/Member' } } } }, '404': { description: 'Not found or not deleted' } },
        },
      },
      '/classes': {
        get: {
          tags: ['Classes'],
          summary: 'List classes',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Classes list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Class' } } } } } },
        },
        post: {
          tags: ['Classes'],
          summary: 'Create a class (admin, coach)',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name', 'starts_at', 'ends_at'], properties: { name: { type: 'string' }, description: { type: 'string' }, capacity: { type: 'integer', default: 10 }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' } } } } } },
          responses: { '201': { description: 'Class created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Class' } } } } },
        },
      },
      '/classes/{id}': {
        get: {
          tags: ['Classes'],
          summary: 'Get a class',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Class', content: { 'application/json': { schema: { $ref: '#/components/schemas/Class' } } } }, '404': { description: 'Not found' } },
        },
        put: {
          tags: ['Classes'],
          summary: 'Update a class (admin, coach)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, capacity: { type: 'integer' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' } } } } } },
          responses: { '200': { description: 'Updated class', content: { 'application/json': { schema: { $ref: '#/components/schemas/Class' } } } }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Classes'],
          summary: 'Delete a class (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },
      '/bookings': {
        get: {
          tags: ['Bookings'],
          summary: 'List bookings',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Bookings list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Booking' } } } } } },
        },
        post: {
          tags: ['Bookings'],
          summary: 'Create a booking (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_id', 'class_id'], properties: { member_id: { type: 'integer' }, class_id: { type: 'integer' } } } } } },
          responses: { '201': { description: 'Booking created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Booking' } } } } },
        },
      },
      '/bookings/{id}': {
        get: {
          tags: ['Bookings'],
          summary: 'Get a booking',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Booking', content: { 'application/json': { schema: { $ref: '#/components/schemas/Booking' } } } }, '404': { description: 'Not found' } },
        },
        put: {
          tags: ['Bookings'],
          summary: 'Update booking status (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['confirmed', 'cancelled'] } } } } } },
          responses: { '200': { description: 'Updated booking', content: { 'application/json': { schema: { $ref: '#/components/schemas/Booking' } } } }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Bookings'],
          summary: 'Delete a booking (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },
      '/subscriptions': {
        get: {
          tags: ['Subscriptions'],
          summary: 'List subscriptions',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          responses: { '200': { description: 'Subscriptions list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Subscription' } } } } } },
        },
        post: {
          tags: ['Subscriptions'],
          summary: 'Create a subscription (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['member_id', 'plan', 'starts_at'], properties: { member_id: { type: 'integer' }, plan: { type: 'string' }, starts_at: { type: 'string', format: 'date' }, ends_at: { type: 'string', format: 'date' } } } } } },
          responses: { '201': { description: 'Subscription created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } } },
        },
      },
      '/subscriptions/{id}': {
        get: {
          tags: ['Subscriptions'],
          summary: 'Get a subscription',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Subscription', content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } }, '404': { description: 'Not found' } },
        },
        put: {
          tags: ['Subscriptions'],
          summary: 'Update a subscription (admin, staff)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { plan: { type: 'string' }, starts_at: { type: 'string', format: 'date' }, ends_at: { type: 'string', format: 'date' }, status: { type: 'string', enum: ['active', 'cancelled', 'expired'] } } } } } },
          responses: { '200': { description: 'Updated subscription', content: { 'application/json': { schema: { $ref: '#/components/schemas/Subscription' } } } }, '404': { description: 'Not found' } },
        },
        delete: {
          tags: ['Subscriptions'],
          summary: 'Delete a subscription (admin)',
          parameters: [{ $ref: '#/components/parameters/gymId' }, { in: 'path', name: 'id', required: true, schema: { type: 'integer' } }],
          responses: { '204': { description: 'Deleted' }, '404': { description: 'Not found' } },
        },
      },
    },
  },
  apis: [],
});
