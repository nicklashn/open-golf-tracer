import type { Metadata } from 'next';
import dynamic from 'next/dynamic';

export const metadata: Metadata = { title: 'Editor', robots: { index: false } };

// The editor is heavy (renderer, physics, timeline): load it only on this route.
const Editor = dynamic(() => import('@/editor/Editor').then((m) => m.Editor));

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Editor projectId={id} />;
}
