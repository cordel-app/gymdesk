// Public privacy policy, linked from the Google OAuth consent screen
// ("Cordel Fitness Pro"). Google refuses to publish an External OAuth app
// without a reachable privacy policy URL on an authorized domain, so this page
// must stay public (see isPublicRoute in src/middleware.ts).

export const PRIVACY_CONTACT_EMAIL = 'xavier.egea@gmail.com';
export const PRIVACY_LAST_UPDATED = '2026-09-30';

export type PrivacySection = { heading: string; paragraphs: string[] };
export type PrivacyContent = { title: string; lastUpdated: string; intro: string; sections: PrivacySection[] };

const en: PrivacyContent = {
  title: 'Privacy Policy',
  lastUpdated: 'Last updated',
  intro:
    'Cordel Fitness Pro is a gym management platform. This policy explains what personal data we process when gyms, their staff and their members use the platform, and why.',
  sections: [
    {
      heading: 'Who is responsible',
      paragraphs: [
        'Each gym using Cordel Fitness Pro is responsible for the data of its own members and staff. Cordel Fitness Pro processes that data on the gym\'s behalf to provide the service.',
        `For questions about this policy, contact ${PRIVACY_CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: 'What data we process',
      paragraphs: [
        'Account data: name, email address and profile photo. When you sign in with Google we receive only your name, email address and profile photo; we do not access your Gmail, contacts, files or any other Google data.',
        'Gym data: memberships, bookings, attendance, training and nutrition plans, and payment records that the gym creates while using the platform.',
      ],
    },
    {
      heading: 'Why we process it',
      paragraphs: [
        'To let you sign in, to provide the features the gym uses (memberships, bookings, billing, training), to send service emails such as booking or payment notifications, and to keep the platform secure.',
        'We do not sell personal data and do not use it for advertising.',
      ],
    },
    {
      heading: 'Service providers',
      paragraphs: [
        'We rely on providers that process data on our behalf: Clerk (authentication), Google (sign-in with Google), Oracle Cloud (database hosting), Cloudflare R2 (image storage), Resend (email delivery) and the gym\'s payment provider (payments).',
      ],
    },
    {
      heading: 'Retention',
      paragraphs: [
        'We keep data while the gym uses the platform and as long as the law requires afterwards, for example for billing records. Deleted records are removed after the gym\'s recycle-bin period.',
      ],
    },
    {
      heading: 'Your rights',
      paragraphs: [
        `You can ask to access, correct or delete your personal data, or object to its processing, by contacting your gym or ${PRIVACY_CONTACT_EMAIL}. You may also complain to your data protection authority (in Spain, the AEPD).`,
      ],
    },
  ],
};

const es: PrivacyContent = {
  title: 'Política de privacidad',
  lastUpdated: 'Última actualización',
  intro:
    'Cordel Fitness Pro es una plataforma de gestión de gimnasios. Esta política explica qué datos personales tratamos cuando los gimnasios, su personal y sus socios usan la plataforma, y con qué fin.',
  sections: [
    {
      heading: 'Responsable',
      paragraphs: [
        'Cada gimnasio que usa Cordel Fitness Pro es responsable de los datos de sus socios y de su personal. Cordel Fitness Pro trata esos datos por cuenta del gimnasio para prestar el servicio.',
        `Para cualquier consulta sobre esta política, escribe a ${PRIVACY_CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: 'Qué datos tratamos',
      paragraphs: [
        'Datos de cuenta: nombre, correo electrónico y foto de perfil. Si inicias sesión con Google solo recibimos tu nombre, correo electrónico y foto de perfil; no accedemos a tu Gmail, contactos, archivos ni a ningún otro dato de Google.',
        'Datos del gimnasio: altas, reservas, asistencia, planes de entrenamiento y nutrición, y registros de pago que el gimnasio crea al usar la plataforma.',
      ],
    },
    {
      heading: 'Para qué los tratamos',
      paragraphs: [
        'Para que puedas iniciar sesión, ofrecer las funciones que usa el gimnasio (altas, reservas, cobros, entrenamiento), enviar correos del servicio como avisos de reservas o pagos, y mantener la plataforma segura.',
        'No vendemos datos personales ni los usamos con fines publicitarios.',
      ],
    },
    {
      heading: 'Proveedores',
      paragraphs: [
        'Nos apoyamos en proveedores que tratan datos por nuestra cuenta: Clerk (autenticación), Google (inicio de sesión con Google), Oracle Cloud (alojamiento de la base de datos), Cloudflare R2 (almacenamiento de imágenes), Resend (envío de correos) y el proveedor de pagos del gimnasio (cobros).',
      ],
    },
    {
      heading: 'Conservación',
      paragraphs: [
        'Conservamos los datos mientras el gimnasio usa la plataforma y, después, durante el tiempo que exija la ley, por ejemplo para los registros de facturación. Los registros eliminados se borran al terminar el periodo de la papelera del gimnasio.',
      ],
    },
    {
      heading: 'Tus derechos',
      paragraphs: [
        `Puedes pedir el acceso, la rectificación o la supresión de tus datos, u oponerte a su tratamiento, contactando con tu gimnasio o con ${PRIVACY_CONTACT_EMAIL}. También puedes reclamar ante la Agencia Española de Protección de Datos (AEPD).`,
      ],
    },
  ],
};

const ca: PrivacyContent = {
  title: 'Política de privadesa',
  lastUpdated: 'Darrera actualització',
  intro:
    'Cordel Fitness Pro és una plataforma de gestió de gimnasos. Aquesta política explica quines dades personals tractem quan els gimnasos, el seu personal i els seus socis fan servir la plataforma, i amb quina finalitat.',
  sections: [
    {
      heading: 'Responsable',
      paragraphs: [
        'Cada gimnàs que fa servir Cordel Fitness Pro és responsable de les dades dels seus socis i del seu personal. Cordel Fitness Pro tracta aquestes dades per compte del gimnàs per prestar el servei.',
        `Per a qualsevol consulta sobre aquesta política, escriu a ${PRIVACY_CONTACT_EMAIL}.`,
      ],
    },
    {
      heading: 'Quines dades tractem',
      paragraphs: [
        "Dades de compte: nom, correu electrònic i foto de perfil. Si inicies sessió amb Google només rebem el teu nom, correu electrònic i foto de perfil; no accedim al teu Gmail, contactes, fitxers ni a cap altra dada de Google.",
        'Dades del gimnàs: altes, reserves, assistència, plans d\'entrenament i nutrició, i registres de pagament que el gimnàs crea en fer servir la plataforma.',
      ],
    },
    {
      heading: 'Per a què les tractem',
      paragraphs: [
        "Perquè puguis iniciar sessió, oferir les funcions que fa servir el gimnàs (altes, reserves, cobraments, entrenament), enviar correus del servei com avisos de reserves o pagaments, i mantenir la plataforma segura.",
        'No venem dades personals ni les fem servir amb finalitats publicitàries.',
      ],
    },
    {
      heading: 'Proveïdors',
      paragraphs: [
        "Ens recolzem en proveïdors que tracten dades per compte nostre: Clerk (autenticació), Google (inici de sessió amb Google), Oracle Cloud (allotjament de la base de dades), Cloudflare R2 (emmagatzematge d'imatges), Resend (enviament de correus) i el proveïdor de pagaments del gimnàs (cobraments).",
      ],
    },
    {
      heading: 'Conservació',
      paragraphs: [
        'Conservem les dades mentre el gimnàs fa servir la plataforma i, després, durant el temps que exigeixi la llei, per exemple per als registres de facturació. Els registres eliminats s\'esborren en acabar el període de la paperera del gimnàs.',
      ],
    },
    {
      heading: 'Els teus drets',
      paragraphs: [
        `Pots demanar l'accés, la rectificació o la supressió de les teves dades, o oposar-te al seu tractament, contactant amb el teu gimnàs o amb ${PRIVACY_CONTACT_EMAIL}. També pots reclamar davant l'Agència Espanyola de Protecció de Dades (AEPD) o l'Autoritat Catalana de Protecció de Dades (APDCAT).`,
      ],
    },
  ],
};

const CONTENT: Record<string, PrivacyContent> = { en, es, ca };

export function privacyContentFor(locale: string): PrivacyContent {
  return CONTENT[locale] ?? en;
}
