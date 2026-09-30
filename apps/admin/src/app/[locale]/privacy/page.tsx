import type { Metadata } from 'next';
import { PRIVACY_LAST_UPDATED, privacyContentFor } from './privacyContent';

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  return { title: `${privacyContentFor(params.locale).title} · Cordel Fitness Pro` };
}

export default function PrivacyPage({ params }: { params: { locale: string } }) {
  const content = privacyContentFor(params.locale);

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 20px', lineHeight: 1.6 }}>
      <h1 style={{ marginTop: 0 }}>{content.title}</h1>
      <p style={{ color: '#666', fontSize: 14 }}>
        {content.lastUpdated}: {PRIVACY_LAST_UPDATED}
      </p>
      <p>{content.intro}</p>
      {content.sections.map((section) => (
        <section key={section.heading}>
          <h2 style={{ fontSize: 20, marginTop: 32 }}>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>
      ))}
    </main>
  );
}
