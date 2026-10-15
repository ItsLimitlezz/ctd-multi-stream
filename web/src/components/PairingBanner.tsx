// "CTD OBS plugin wants to connect (code KQ7-2MX). Review" — shown to admins on every page while an
// app pairing waits for approval (except on Settings → API, which lists them).

import { Link, useQuery, useRoute } from '../router';
import { useAuth } from '../state/auth';
import { useNow } from '../state/hooks';
import { pairingBannerText, pendingPairings } from '../state/hub';
import { usePairings } from '../state/live';
import { buttonClass } from './Button';
import { PlugIcon } from './icons';

export function PairingBanner() {
  const { isAdmin } = useAuth();
  const pairings = usePairings();
  const route = useRoute();
  const query = useQuery();
  const any = isAdmin && (pairings?.length ?? 0) > 0;
  const now = useNow(any ? 15_000 : null);
  if (!any) return null;
  if (route.name === 'settings' && query.get('tab') === 'api') return null;
  const pending = pendingPairings(pairings, now);
  if (pending.length === 0) return null;
  const target = pending.length === 1 ? `/settings?tab=api&pair=${encodeURIComponent((pending[0] as { id: string }).id)}` : '/settings?tab=api';
  return (
    <div className="pairing-banner" role="status">
      <PlugIcon width={18} height={18} />
      <span className="pairing-banner-text">{pairingBannerText(pending)}</span>
      <Link to={target} className={buttonClass('primary', 'sm')}>
        Review
      </Link>
    </div>
  );
}
