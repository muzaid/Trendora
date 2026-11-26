import { ShareLanding } from './share-landing';

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ShareLanding token={token} />;
}
