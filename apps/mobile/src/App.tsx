import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View, I18nManager } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useVideoPlayer, VideoView } from 'expo-video';
import { api, getToken, setToken, type ApiError, type FeedItem, type LeaderboardRow, type Reward } from './api';
import { colors, minTarget, money } from './theme';

type Tab = 'feed' | 'arena' | 'rewards';

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('feed');
  const [arena, setArena] = useState<string | null>(null);
  useEffect(() => { void getToken().then((t) => setSignedIn(!!t)); }, []);
  if (signedIn === null) return <Center><ActivityIndicator color={colors.violet} /></Center>;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <View style={s.header}>
          <Text style={s.brand} accessibilityRole="header">TREND<Text style={{ color: colors.violet }}>ORA</Text></Text>
          <Text style={s.sandbox}>SANDBOX</Text>
        </View>
        {!signedIn ? <Login onDone={() => setSignedIn(true)} /> : (
          <View style={{ flex: 1 }}>
            {tab === 'feed' && <Feed onOpenArena={(id) => { setArena(id); setTab('arena'); }} />}
            {tab === 'arena' && (arena ? <Arena campaignId={arena} /> : <Center><Text style={s.muted}>Open a challenge from the feed.</Text></Center>)}
            {tab === 'rewards' && <Rewards onSignOut={async () => { await setToken(null); setSignedIn(false); }} />}
            <View style={s.tabs} accessibilityRole="tablist">
              {(['feed', 'arena', 'rewards'] as Tab[]).map((t) => (
                <Pressable key={t} onPress={() => setTab(t)} style={[s.tab, tab === t && s.tabActive]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
                  <Text style={s.tabText}>{t === 'feed' ? 'Feed' : t === 'arena' ? 'Arena' : 'Rewards'}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <View style={[s.root, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [handle, setHandle] = useState('creator_01');
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ padding: 16, gap: 12 }}>
      <Text style={s.h1}>Sign in (sandbox)</Text>
      <Text style={s.muted}>Use a seeded handle, e.g. creator_01 or viewer_01. Production uses Supabase Auth.</Text>
      <TextInput value={handle} onChangeText={setHandle} autoCapitalize="none" style={s.input} accessibilityLabel="Handle" />
      {error && <Text style={{ color: colors.danger }}>{error}</Text>}
      <Btn label="Sign in" primary onPress={async () => {
        try {
          const r = await api<{ token: string }>('/v1/auth/sandbox-login', { body: { handle } });
          await setToken(r.token);
          onDone();
        } catch (e) { setError((e as ApiError).message); }
      }} />
    </View>
  );
}

function Feed({ onOpenArena }: { onOpenArena: (id: string) => void }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (c?: string | null) => {
    setLoading(true);
    try {
      const r = await api<{ items: FeedItem[]; nextCursor: string | null }>(`/v1/feed?limit=5${c ? `&cursor=${encodeURIComponent(c)}` : ''}`);
      setItems((x) => (c ? [...x, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.entryId}
      onEndReached={() => cursor && !loading && void load(cursor)}
      refreshing={loading}
      onRefresh={() => void load()}
      contentContainerStyle={{ padding: 12, gap: 16 }}
      renderItem={({ item }) => <Card item={item} onOpenArena={onOpenArena} />}
    />
  );
}

function Card({ item, onOpenArena }: { item: FeedItem; onOpenArena: (id: string) => void }) {
  const [liked, setLiked] = useState(item.likedByMe);
  const [likes, setLikes] = useState(item.likeCount);
  // Never autoplay audio: player starts paused and muted.
  const player = useVideoPlayer(item.playbackUrl ?? null, (p) => { p.muted = true; p.loop = false; });
  useEffect(() => { void api(`/v1/entries/${item.entryId}/events`, { body: { type: 'IMPRESSION', source: 'ORGANIC' } }).catch(() => undefined); }, [item.entryId]);
  const tag = item.productTags[0];
  return (
    <View style={s.card} accessible accessibilityLabel={`Entry by ${item.creatorHandle} in ${item.campaignTitle}`}>
      <Text style={s.disclosure}>Sponsored · {item.storeName}</Text>
      {item.playbackUrl && <VideoView player={player} style={{ width: '100%', aspectRatio: 9 / 16, backgroundColor: '#000' }} nativeControls contentFit="cover" />}
      <Text style={s.bold}>@{item.creatorHandle}</Text>
      <Text style={s.text}>{item.caption}</Text>
      {tag && <Text style={s.muted}>{tag.title}: <Text style={{ textDecorationLine: 'line-through' }}>{money(tag.regularMinor, tag.currency)}</Text> <Text style={{ color: colors.success }}>{money(tag.offerMinor, tag.currency)}</Text></Text>}
      <View style={{ flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn label={`${liked ? '♥' : '♡'} ${likes}`} accessibilityLabel={liked ? 'Unlike' : 'Like'} onPress={async () => {
          const r = await api<{ active: boolean; changed: boolean }>(`/v1/entries/${item.entryId}/like`, { method: 'PUT', body: { active: !liked } });
          if (r.changed) setLikes((n) => n + (r.active ? 1 : -1));
          setLiked(r.active);
        }} />
        <Btn label="Challenge" primary onPress={() => onOpenArena(item.campaignId)} />
      </View>
    </View>
  );
}

function Arena({ campaignId }: { campaignId: string }) {
  const [data, setData] = useState<{ title: string; status: string; voteEnd: string; rows: LeaderboardRow[]; boardStatus: string } | null>(null);
  useEffect(() => {
    const load = async () => {
      const c = await api<{ title: string; status: string; voteEnd: string }>(`/v1/campaigns/${campaignId}`);
      const b = await api<{ status: string; rows: LeaderboardRow[] }>(`/v1/campaigns/${campaignId}/leaderboard`);
      setData({ ...c, rows: b.rows, boardStatus: b.status });
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [campaignId]);
  if (!data) return <Center><ActivityIndicator color={colors.violet} /></Center>;
  return (
    <FlatList
      ListHeaderComponent={<View style={{ gap: 4, marginBottom: 12 }}><Text style={s.h1}>{data.title}</Text><Text style={s.muted}>{data.status} · voting ends {new Date(data.voteEnd).toLocaleString()} · {data.boardStatus.toLowerCase()} leaderboard</Text></View>}
      data={data.rows}
      keyExtractor={(r) => r.entryId}
      contentContainerStyle={{ padding: 16 }}
      renderItem={({ item }) => (
        <View style={s.row}><Text style={[s.bold, { width: 48 }]}>#{item.rank}</Text><Text style={[s.text, { flex: 1 }]}>@{item.creatorHandle}</Text><Text style={s.text}>{item.score.toFixed(2)}</Text></View>
      )}
    />
  );
}

function Rewards({ onSignOut }: { onSignOut: () => void }) {
  const [rewards, setRewards] = useState<Reward[] | null>(null);
  useEffect(() => { void api<Reward[]>('/v1/me/rewards').then(setRewards); }, []);
  return (
    <FlatList
      data={rewards ?? []}
      keyExtractor={(r) => r.id}
      contentContainerStyle={{ padding: 16, gap: 12 }}
      ListEmptyComponent={<Text style={s.muted}>{rewards ? 'No rewards yet.' : 'Loading…'}</Text>}
      ListFooterComponent={<Btn label="Sign out" onPress={onSignOut} />}
      renderItem={({ item }) => (
        <View style={s.card}>
          <Text style={s.bold}>Rank #{item.rank} · {item.title}</Text>
          <Text style={s.muted}>{item.campaignTitle} · {item.status}</Text>
          {item.coupon && <Text selectable style={s.code} accessibilityLabel={`Coupon code ${item.coupon.code}`}>{item.coupon.code}</Text>}
          {item.coupon && <Text style={s.muted}>{item.coupon.percentOff}% off · expires {new Date(item.coupon.expiresAt).toLocaleDateString()} · {item.coupon.status}</Text>}
        </View>
      )}
    />
  );
}

function Btn({ label, onPress, primary, accessibilityLabel }: { label: string; onPress: () => void; primary?: boolean; accessibilityLabel?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} style={({ pressed }) => [s.btn, primary && s.btnPrimary, pressed && { opacity: 0.7 }]}>
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border },
  brand: { color: colors.text, fontWeight: '800', fontSize: 18, letterSpacing: 2 },
  sandbox: { backgroundColor: colors.warning, color: colors.ink, fontWeight: '700', paddingHorizontal: 8, borderRadius: 999, overflow: 'hidden' },
  h1: { color: colors.text, fontSize: 22, fontWeight: '800' },
  text: { color: colors.text, fontSize: 15 },
  bold: { color: colors.text, fontSize: 15, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: 13 },
  input: { minHeight: minTarget, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.text, paddingHorizontal: 12 },
  card: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 },
  disclosure: { alignSelf: 'flex-start', backgroundColor: colors.warning, color: colors.ink, fontWeight: '700', fontSize: 12, paddingHorizontal: 8, borderRadius: 999, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: minTarget, borderBottomWidth: 1, borderColor: colors.border },
  code: { color: colors.text, fontFamily: 'Courier', fontSize: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.violet, padding: 8, borderRadius: 8 },
  btn: { minHeight: minTarget, minWidth: minTarget, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.violet, borderColor: colors.violet },
  btnText: { color: colors.text, fontWeight: '700' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: colors.border },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  tabActive: { borderTopWidth: 3, borderColor: colors.violet },
  tabText: { color: colors.text, fontWeight: '600' },
});
