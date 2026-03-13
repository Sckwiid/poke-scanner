import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlurView } from 'expo-blur';

const API_BASE = 'https://api.tcgdex.net/v2/fr';
const COLLECTION_KEY = '@pokescan/collection-v3';
const TOP_INSET = Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0;

const THEME = {
  bg: '#0f1116',
  panel: '#1b1f2b',
  red: '#d62828',
  white: '#f4f5f6',
  dim: '#9aa1ad',
  info: '#ffb4a2',
  glass: 'rgba(255,255,255,0.12)',
};

const normalize = (value = '') =>
  value
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const cleanSpaces = (value = '') => value.replace(/\s+/g, '');

const extractCardClues = (rawText = '') => {
  const text = rawText.replace(/\r/g, '\n');

  const slashId = text.match(/\b\d{1,3}\s*\/\s*\d{1,3}\b/);
  const codeId = text.match(/\b[A-Z]{1,6}\s*-?\s*\d{1,4}\b/i);
  const bareNumber = text.match(/\b\d{1,3}\b/);

  const localId = slashId
    ? cleanSpaces(slashId[0])
    : codeId
      ? cleanSpaces(codeId[0]).replace('-', '').toUpperCase()
      : bareNumber
        ? bareNumber[0]
        : null;

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const nameLine =
    lines.find((line) => {
      if (/\d{1,3}\s*\/\s*\d{1,3}/.test(line)) return false;
      if (!/[A-Za-z]/.test(line)) return false;
      return line.length >= 3 && line.length <= 36;
    }) || null;

  return {
    rawText,
    localId,
    name: nameLine,
  };
};

const buildLocalIdVariants = (localId = '') => {
  if (!localId) return [];

  const variants = new Set();
  const clean = cleanSpaces(localId).toUpperCase();
  variants.add(clean);

  if (clean.includes('/')) {
    const [left] = clean.split('/');
    if (left) variants.add(left);
  }

  const alphaNum = clean.match(/^([A-Z]{1,6})(\d{1,4})$/);
  if (alphaNum) variants.add(alphaNum[2]);

  if (/^\d+$/.test(clean)) {
    variants.add(String(parseInt(clean, 10)));
  }

  return [...variants].filter(Boolean);
};
const parseLocalId = (value = '') => {
  const clean = cleanSpaces(value).toUpperCase();
  if (!clean) return { raw: '', number: null, total: null };

  const slash = clean.match(/^(\d{1,3})\/(\d{1,3})$/);
  if (slash) {
    return {
      raw: clean,
      number: String(parseInt(slash[1], 10)),
      total: String(parseInt(slash[2], 10)),
    };
  }

  const alphaNum = clean.match(/^[A-Z]{1,6}(\d{1,4})$/);
  if (alphaNum) {
    return { raw: clean, number: String(parseInt(alphaNum[1], 10)), total: null };
  }

  const digits = clean.match(/\d{1,4}/);
  if (digits) {
    return { raw: clean, number: String(parseInt(digits[0], 10)), total: null };
  }

  return { raw: clean, number: null, total: null };
};

const getSetCountCandidates = (setData) => {
  const set = setData || {};
  const out = new Set();

  const pushNum = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.add(String(value));
      return;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      out.add(String(parseInt(value, 10)));
    }
  };

  pushNum(set?.cardCount);
  pushNum(set?.total);
  pushNum(set?.cards);

  if (set?.cardCount && typeof set.cardCount === 'object') {
    Object.values(set.cardCount).forEach(pushNum);
  }

  if (set?.cards && typeof set.cards === 'object') {
    Object.values(set.cards).forEach(pushNum);
  }

  return [...out];
};

const localIdMatches = (candidateLocalId, clueLocalId, setData) => {
  const candidate = parseLocalId(candidateLocalId || '');
  const clue = parseLocalId(clueLocalId || '');

  if (!clue.number || !candidate.number) return false;
  if (candidate.number !== clue.number) return false;

  if (!clue.total) return true;

  const counts = getSetCountCandidates(setData);
  if (!counts.length) return true;

  return counts.includes(clue.total);
};

const nameMatches = (candidateName = '', clueName = '') => {
  const cand = normalize(candidateName);
  const clue = normalize(clueName);
  if (!cand || !clue) return false;
  return cand.includes(clue) || clue.includes(cand);
};
const scoreCandidate = (card, clues) => {
  let score = 0;

  const clueLocal = clues?.localId || '';
  const clueName = clues?.name || '';

  if (clueLocal && localIdMatches(card?.localId || '', clueLocal, card?.set)) {
    score += 130;
  }

  if (clueName && nameMatches(card?.name || '', clueName)) {
    score += 40;
  }

  return score;
};

const toPrettyLabel = (key = '') =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const getCardImageUri = (card) => {
  const source = card?.image || card?.illustration;
  if (!source) return null;

  if (typeof source === 'string') {
    if (/\.(png|jpe?g|webp)$/i.test(source)) return source;
    return `${source}/high.webp`;
  }

  if (typeof source === 'object') {
    return source.high || source.large || source.medium || source.small || source.url || null;
  }

  return null;
};

const getSetLabel = (card) => {
  const setData = card?.set;
  if (!setData) return 'Inconnu';
  if (typeof setData === 'string') return setData;
  return setData?.name || setData?.id || 'Inconnu';
};

const extractPriceRows = (card) => {
  const rows = [];
  const marketRoot = card?.cardmarket || card?.market || null;
  const prices = marketRoot?.prices || card?.prices || null;

  if (marketRoot?.updatedAt) {
    rows.push({
      label: 'Maj',
      value: new Date(marketRoot.updatedAt).toLocaleDateString('fr-FR'),
    });
  }

  const addValue = (label, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      rows.push({ label, value: `${value.toFixed(2)} EUR` });
    }
  };

  if (prices && typeof prices === 'object') {
    Object.entries(prices).forEach(([key, value]) => {
      if (typeof value === 'number') {
        addValue(toPrettyLabel(key), value);
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([subKey, subVal]) => {
          addValue(`${toPrettyLabel(key)} ${toPrettyLabel(subKey)}`, subVal);
        });
      }
    });
  }

  return rows.slice(0, 8);
};

export default function App() {
  const cameraRef = useRef(null);
  const lastAutoScanRef = useRef({ text: '', at: 0 });

  const [permission, requestPermission] = useCameraPermissions();

  const [activeTab, setActiveTab] = useState('scan');

  const [scanEnabled, setScanEnabled] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanPulse, setScanPulse] = useState(0);
  const [scanStatus, setScanStatus] = useState('Mode scan actif. Place la carte dans le cadre.');
  const [lastDetectedText, setLastDetectedText] = useState('');

  const [searchName, setSearchName] = useState('');
  const [searchLocalId, setSearchLocalId] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchStatus, setSearchStatus] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const [collection, setCollection] = useState([]);

  const [modalVisible, setModalVisible] = useState(false);
  const [modalBusy, setModalBusy] = useState(false);
  const [selectedCard, setSelectedCard] = useState(null);
  const [selectedSource, setSelectedSource] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      setScanPulse((prev) => (prev + 1) % 4);
    }, 650);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(COLLECTION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setCollection(parsed);
      } catch {
        // ignore invalid local data
      }
    })();
  }, []);

  const persistCollection = useCallback(async (next) => {
    try {
      await AsyncStorage.setItem(COLLECTION_KEY, JSON.stringify(next));
    } catch {
      // no-op
    }
  }, []);

  const fetchCardsByParam = useCallback(async (param, value) => {
    const url = `${API_BASE}/cards?${param}=${encodeURIComponent(value)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  }, []);

  const fetchCardDetails = useCallback(async (card) => {
    if (!card?.id) return card;
    const res = await fetch(`${API_BASE}/cards/${card.id}`);
    if (!res.ok) return card;
    return res.json();
  }, []);

  const queryCards = useCallback(
    async (clues, { max = 20 } = {}) => {
      const localId = clues?.localId?.trim() || '';
      const name = clues?.name?.trim() || '';

      const tasks = [];
      const localVariants = buildLocalIdVariants(localId);

      for (const variant of localVariants) {
        tasks.push(fetchCardsByParam('localId', variant));
      }

      if (name) {
        tasks.push(fetchCardsByParam('name', name));
      }

      if (!tasks.length) return [];

      const batches = await Promise.all(tasks);
      const merged = batches.flat();
      const byId = new Map();

      merged.forEach((card) => {
        if (card?.id && !byId.has(card.id)) {
          byId.set(card.id, card);
        }
      });

      let list = [...byId.values()];

      if (localId) {
        const localFiltered = list.filter((card) => localIdMatches(card?.localId || '', localId, card?.set));
        if (localFiltered.length) {
          list = localFiltered;
        }
      }

      if (name) {
        const nameFiltered = list.filter((card) => nameMatches(card?.name || '', name));
        if (nameFiltered.length) {
          list = nameFiltered;
        }
      }

      list.sort((a, b) => scoreCandidate(b, clues) - scoreCandidate(a, clues));
      return list.slice(0, max);
    },
    [fetchCardsByParam]
  );

  const openCardModal = useCallback(
    async (card, source = '') => {
      setSelectedSource(source);
      setModalVisible(true);
      setModalBusy(true);
      try {
        const details = await fetchCardDetails(card);
        setSelectedCard(details);
      } catch {
        setSelectedCard(card);
      } finally {
        setModalBusy(false);
      }
    },
    [fetchCardDetails]
  );

  const isCardInCollection = useCallback(
    (cardId) => collection.some((item) => item.card?.id === cardId),
    [collection]
  );

  const addToCollection = useCallback(
    (card) => {
      if (!card?.id) return;

      setCollection((prev) => {
        const idx = prev.findIndex((item) => item.card?.id === card.id);
        let next;

        if (idx >= 0) {
          next = [...prev];
          next[idx] = {
            ...next[idx],
            qty: next[idx].qty + 1,
            updatedAt: new Date().toISOString(),
          };
        } else {
          next = [
            {
              id: card.id,
              qty: 1,
              addedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              card,
            },
            ...prev,
          ];
        }

        persistCollection(next);
        return next;
      });
    },
    [persistCollection]
  );

  const decrementCollection = useCallback(
    (cardId) => {
      setCollection((prev) => {
        const idx = prev.findIndex((item) => item.card?.id === cardId);
        if (idx < 0) return prev;

        const current = prev[idx];
        let next;

        if (current.qty <= 1) {
          next = prev.filter((item) => item.card?.id !== cardId);
        } else {
          next = [...prev];
          next[idx] = {
            ...next[idx],
            qty: next[idx].qty - 1,
            updatedAt: new Date().toISOString(),
          };
        }

        persistCollection(next);
        return next;
      });
    },
    [persistCollection]
  );

  const clearCollection = useCallback(() => {
    Alert.alert('Collection', 'Supprimer toute la collection ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer',
        style: 'destructive',
        onPress: async () => {
          setCollection([]);
          try {
            await AsyncStorage.removeItem(COLLECTION_KEY);
          } catch {
            // no-op
          }
        },
      },
    ]);
  }, []);

  const runAutoScan = useCallback(
    async (rawText, source = 'unknown') => {
      if (!scanEnabled || scanBusy || modalVisible) return;

      const text = (rawText || '').trim();
      if (!text || text.length < 3) return;

      const now = Date.now();
      const fingerprint = text.slice(0, 140);
      const last = lastAutoScanRef.current;

      if (fingerprint === last.text && now - last.at < 4500) return;
      if (now - last.at < 1400) return;

      lastAutoScanRef.current = { text: fingerprint, at: now };
      setLastDetectedText(text.slice(0, 100));

      const clues = extractCardClues(text);

      if (!clues.localId) {
        if (clues.name) {
          setSearchName(clues.name);
          setScanStatus('Nom detecte sans ID. Ouvre Rechercher pour choisir la bonne carte.');
        } else {
          setScanStatus('Detection en cours... aucun localId reconnu pour le moment.');
        }
        return;
      }

      setScanBusy(true);
      setScanStatus(`ID detecte: ${clues.localId} (${source}) -> recherche...`);

      try {
        const results = await queryCards(clues, { max: 8 });

        if (!results.length) {
          setScanStatus(`Aucune carte trouvee pour ${clues.localId}.`);
          return;
        }

        const best = results[0];
        const bestScore = scoreCandidate(best, clues);
        const secondScore = results[1] ? scoreCandidate(results[1], clues) : -999;

        if (results.length > 1 && bestScore - secondScore < 18) {
          setSearchResults(results);
          setSearchStatus('Plusieurs cartes proches detectees. Choisis dans la liste.');
          setSearchLocalId(clues.localId || '');
          setActiveTab('search');
          setScanStatus('Cartes proches detectees, verification manuelle conseillee.');
          return;
        }

        setScanStatus(`Carte detectee: ${best?.name || 'Inconnue'}`);
        await openCardModal(best, source);
      } catch {
        setScanStatus('Erreur reseau pendant le scan.');
      } finally {
        setScanBusy(false);
      }
    },
    [modalVisible, openCardModal, queryCards, scanBusy, scanEnabled]
  );

  const onBarcodeScanned = useCallback(
    ({ data }) => {
      if (data) runAutoScan(data, 'barcode');
    },
    [runAutoScan]
  );

  const runSearch = useCallback(async () => {
    const name = searchName.trim();
    const localId = searchLocalId.trim();

    if (!name && !localId) {
      setSearchStatus('Entre au moins un nom ou un localId.');
      setSearchResults([]);
      return;
    }

    setSearchBusy(true);
    setSearchStatus('Recherche en cours...');

    try {
      const clues = { name: name || null, localId: localId || null };
      const results = await queryCards(clues, { max: 25 });
      setSearchResults(results);
      setSearchStatus(results.length ? `${results.length} resultat(s)` : 'Aucun resultat');
    } catch {
      setSearchStatus('Erreur reseau pendant la recherche.');
      setSearchResults([]);
    } finally {
      setSearchBusy(false);
    }
  }, [queryCards, searchLocalId, searchName]);

  const clearSearch = useCallback(() => {
    setSearchName('');
    setSearchLocalId('');
    setSearchResults([]);
    setSearchStatus('');
  }, []);

  const selectedImage = useMemo(() => getCardImageUri(selectedCard), [selectedCard]);
  const priceRows = useMemo(() => extractPriceRows(selectedCard), [selectedCard]);

  const scanIndicator = scanEnabled
    ? `Scan actif${'.'.repeat((scanPulse % 3) + 1)}`
    : 'Scan en pause';

  const renderCamera = () => (
    <CameraView
      ref={cameraRef}
      style={StyleSheet.absoluteFill}
      facing="back"
      onBarcodeScanned={onBarcodeScanned}
      barcodeScannerSettings={{
        barcodeTypes: ['qr', 'code128', 'code39', 'ean13', 'ean8', 'upc_a', 'upc_e'],
      }}
    />
  );

  const renderScanTab = () => (
    <View style={styles.cameraWrap}>
      {renderCamera()}

      <View style={styles.overlay}>
        <View style={styles.scanFrame} />
      </View>

      <View style={styles.scanPanel}>
        <Text style={styles.engineText}> Scan auto actif (codes). OCR texte complet necessite un Dev Build Expo. </Text>

        <Text style={styles.liveText}>{scanIndicator}</Text>
        <Text style={styles.statusText}>{scanStatus}</Text>

        {lastDetectedText ? (
          <Text numberOfLines={2} style={styles.detectedText}>
            Derniere detection: {lastDetectedText}
          </Text>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.actionButton, styles.primaryAction, styles.rowBtn, !scanEnabled && styles.secondaryLook]}
            onPress={() => setScanEnabled((prev) => !prev)}
          >
            <Text style={styles.actionButtonText}>{scanEnabled ? 'Pause' : 'Reprendre'}</Text>
          </Pressable>

          <Pressable
            style={[styles.actionButton, styles.secondaryAction, styles.rowBtn]}
            onPress={() => setActiveTab('search')}
          >
            <Text style={styles.actionButtonText}>Rechercher</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  const renderSearchTab = () => (
    <View style={styles.tabContent}>
      <Text style={styles.sectionTitle}>Rechercher une carte</Text>

      <TextInput
        style={styles.input}
        value={searchName}
        onChangeText={setSearchName}
        placeholder="Nom (ex: Pikachu)"
        placeholderTextColor={THEME.dim}
      />

      <TextInput
        style={styles.input}
        value={searchLocalId}
        onChangeText={setSearchLocalId}
        placeholder="Local ID (ex: 123/198 ou SWSH123)"
        placeholderTextColor={THEME.dim}
      />

      <View style={styles.actionRow}>
        <Pressable style={[styles.actionButton, styles.primaryAction, styles.rowBtn]} onPress={runSearch} disabled={searchBusy}>
          {searchBusy ? <ActivityIndicator color={THEME.white} /> : <Text style={styles.actionButtonText}>Rechercher</Text>}
        </Pressable>

        <Pressable style={[styles.actionButton, styles.secondaryAction, styles.rowBtn]} onPress={clearSearch}>
          <Text style={styles.actionButtonText}>Effacer</Text>
        </Pressable>
      </View>

      {searchStatus ? <Text style={styles.helperText}>{searchStatus}</Text> : null}

      <FlatList
        data={searchResults}
        keyExtractor={(item) => item.id}
        contentContainerStyle={searchResults.length ? styles.resultList : styles.emptyList}
        ListEmptyComponent={<Text style={styles.centerText}>Aucun resultat pour le moment.</Text>}
        renderItem={({ item }) => {
          const imageUri = getCardImageUri(item);
          return (
            <Pressable style={styles.resultCard} onPress={() => openCardModal(item, 'search')}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={styles.resultImage} />
              ) : (
                <View style={[styles.resultImage, styles.imagePlaceholder]}>
                  <Text style={styles.placeholderText}>No Image</Text>
                </View>
              )}

              <View style={styles.resultInfo}>
                <Text style={styles.resultName}>{item?.name || 'Carte inconnue'}</Text>
                <Text style={styles.resultMeta}>ID: {item?.localId || '-'}</Text>
                <Text style={styles.resultMeta}>Set: {getSetLabel(item)}</Text>

                <Pressable style={styles.miniBtn} onPress={() => addToCollection(item)}>
                  <Text style={styles.miniBtnText}>{isCardInCollection(item.id) ? 'Ajouter +1' : 'Ajouter collection'}</Text>
                </Pressable>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );

  const renderCollectionTab = () => (
    <View style={styles.tabContent}>
      <View style={styles.rowBetween}>
        <Text style={styles.sectionTitle}>Ma collection</Text>
        <Pressable onPress={clearCollection}>
          <Text style={styles.clearText}>Tout vider</Text>
        </Pressable>
      </View>

      <FlatList
        data={collection}
        keyExtractor={(item) => item.id}
        contentContainerStyle={collection.length ? styles.resultList : styles.emptyList}
        ListEmptyComponent={<Text style={styles.centerText}>Ta collection est vide.</Text>}
        renderItem={({ item }) => {
          const imageUri = getCardImageUri(item.card);
          return (
            <Pressable style={styles.resultCard} onPress={() => openCardModal(item.card, 'collection')}>
              {imageUri ? (
                <Image source={{ uri: imageUri }} style={styles.resultImage} />
              ) : (
                <View style={[styles.resultImage, styles.imagePlaceholder]}>
                  <Text style={styles.placeholderText}>No Image</Text>
                </View>
              )}

              <View style={styles.resultInfo}>
                <Text style={styles.resultName}>{item?.card?.name || 'Carte inconnue'}</Text>
                <Text style={styles.resultMeta}>ID: {item?.card?.localId || '-'}</Text>
                <Text style={styles.resultMeta}>Set: {getSetLabel(item?.card)}</Text>
                <Text style={styles.qtyText}>Quantite: {item.qty}</Text>

                <View style={styles.qtyRow}>
                  <Pressable style={styles.qtyBtn} onPress={() => decrementCollection(item.card.id)}>
                    <Text style={styles.qtyBtnText}>-</Text>
                  </Pressable>
                  <Pressable style={styles.qtyBtn} onPress={() => addToCollection(item.card)}>
                    <Text style={styles.qtyBtnText}>+</Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={THEME.red} />
        <Text style={styles.centerText}>Initialisation camera...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.appTitle}>PokeScan</Text>
        <Text style={styles.centerText}>Permission camera necessaire pour le scan.</Text>
        <Pressable style={[styles.actionButton, styles.primaryAction, styles.singleButton]} onPress={requestPermission}>
          <Text style={styles.actionButtonText}>Autoriser la camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeTop}>
        <View style={styles.header}>
          <Text style={styles.appTitle}>PokeScan</Text>
          <Text style={styles.subtitle}>Scan | Rechercher | Collection</Text>
        </View>
      </SafeAreaView>
      <View style={styles.body}>
        {activeTab === 'scan' && renderScanTab()}
        {activeTab === 'search' && renderSearchTab()}
        {activeTab === 'collection' && renderCollectionTab()}
      </View>

      <View style={styles.tabBar}>
        <Pressable style={[styles.tabBtn, activeTab === 'scan' && styles.tabBtnActive]} onPress={() => setActiveTab('scan')}>
          <Text style={[styles.tabText, activeTab === 'scan' && styles.tabTextActive]}>Scan</Text>
        </Pressable>
        <Pressable style={[styles.tabBtn, activeTab === 'search' && styles.tabBtnActive]} onPress={() => setActiveTab('search')}>
          <Text style={[styles.tabText, activeTab === 'search' && styles.tabTextActive]}>Rechercher</Text>
        </Pressable>
        <Pressable style={[styles.tabBtn, activeTab === 'collection' && styles.tabBtnActive]} onPress={() => setActiveTab('collection')}>
          <Text style={[styles.tabText, activeTab === 'collection' && styles.tabTextActive]}>Collection</Text>
        </Pressable>
      </View>      <Modal visible={modalVisible} transparent animationType="fade" onRequestClose={() => setModalVisible(false)}>
        <View style={styles.modalBackdrop}>
          <BlurView intensity={38} tint="dark" style={styles.modalCard}>
            {modalBusy ? (
              <View style={styles.center}>
                <ActivityIndicator color={THEME.red} />
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.modalScrollContent}>
                <Text style={styles.modalTitle}>{selectedCard?.name || 'Carte detectee'}</Text>
                <Text style={styles.modalSource}>Source: {selectedSource || '-'}</Text>

                {selectedImage ? (
                  <Image source={{ uri: selectedImage }} style={styles.modalImage} resizeMode="contain" />
                ) : (
                  <View style={[styles.modalImage, styles.imagePlaceholder]}>
                    <Text style={styles.placeholderText}>No Image</Text>
                  </View>
                )}

                <View style={styles.infoBox}>
                  <Text style={styles.infoLine}>Local ID: {selectedCard?.localId || '-'}</Text>
                  <Text style={styles.infoLine}>Rarete: {selectedCard?.rarity || 'Inconnue'}</Text>
                  <Text style={styles.infoLine}>Set: {getSetLabel(selectedCard)}</Text>
                  <Text style={styles.infoLine}>Artiste: {selectedCard?.illustrator || selectedCard?.artist || 'Inconnu'}</Text>
                </View>

                <View style={styles.infoBox}>
                  <Text style={styles.priceTitle}>Prix</Text>
                  {priceRows.length ? (
                    priceRows.map((row, idx) => (
                      <Text key={`${row.label}-${idx}`} style={styles.infoLine}>
                        {row.label}: {row.value}
                      </Text>
                    ))
                  ) : (
                    <Text style={styles.infoLine}>Aucune donnee prix disponible.</Text>
                  )}
                </View>

                <View style={styles.modalBtnRow}>
                  <Pressable style={[styles.actionButton, styles.primaryAction, styles.modalBtn]} onPress={() => addToCollection(selectedCard)}>
                    <Text style={styles.actionButtonText}>{isCardInCollection(selectedCard?.id) ? 'Ajouter +1' : 'Ajouter collection'}</Text>
                  </Pressable>
                  <Pressable style={[styles.actionButton, styles.secondaryAction, styles.modalBtn]} onPress={() => setModalVisible(false)}>
                    <Text style={styles.actionButtonText}>Fermer</Text>
                  </Pressable>
                </View>
              </ScrollView>
            )}
          </BlurView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: THEME.bg,
  },
  body: {
    flex: 1,
  },
  safeTop: {
    backgroundColor: 'rgba(15,17,22,0.85)',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: TOP_INSET + 10,
    paddingBottom: 8,
    
  },
  appTitle: {
    color: THEME.white,
    fontSize: 22,
    fontWeight: '800',
  },
  subtitle: {
    color: THEME.dim,
    fontSize: 12,
    marginTop: 2,
  },
  center: {
    flex: 1,
    backgroundColor: THEME.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  centerText: {
    color: THEME.white,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 20,
  },
  cameraWrap: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    pointerEvents: 'none',
  },
  scanFrame: {
    width: '78%',
    aspectRatio: 0.72,
    borderWidth: 3,
    borderColor: '#ffffff',
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  scanPanel: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 88,
    backgroundColor: 'rgba(15,17,22,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 16,
    padding: 12,
  },
  engineText: {
    color: THEME.info,
    fontSize: 12,
    marginBottom: 4,
  },
  liveText: {
    color: '#b7ffb7',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
  },
  statusText: {
    color: THEME.white,
    fontSize: 13,
    marginBottom: 8,
  },
  detectedText: {
    color: '#c3c7d1',
    fontSize: 11,
    marginBottom: 10,
  },
  tabContent: {
    flex: 1,
    paddingTop: 14,
    paddingHorizontal: 12,
    paddingBottom: 84,
  },
  sectionTitle: {
    color: THEME.white,
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 12,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    color: THEME.white,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 10,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  actionButton: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryAction: {
    backgroundColor: THEME.red,
  },
  secondaryAction: {
    backgroundColor: '#2a2f3c',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    marginLeft: 10,
  },
  secondaryLook: {
    backgroundColor: '#2a2f3c',
  },
  rowBtn: {
    flex: 1,
  },
  singleButton: {
    minWidth: 220,
    marginTop: 14,
  },
  actionButtonText: {
    color: THEME.white,
    fontWeight: '700',
  },
  helperText: {
    color: THEME.dim,
    marginTop: 8,
    marginBottom: 8,
  },
  resultList: {
    paddingBottom: 10,
    paddingTop: 8,
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  resultCard: {
    flexDirection: 'row',
    backgroundColor: THEME.panel,
    borderRadius: 14,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  resultImage: {
    width: 74,
    height: 102,
    borderRadius: 10,
    backgroundColor: '#202534',
  },
  imagePlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: THEME.dim,
    fontSize: 11,
  },
  resultInfo: {
    flex: 1,
    marginLeft: 10,
    justifyContent: 'center',
  },
  resultName: {
    color: THEME.white,
    fontSize: 16,
    fontWeight: '700',
  },
  resultMeta: {
    color: THEME.dim,
    fontSize: 12,
    marginTop: 2,
  },
  miniBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: 'rgba(214,40,40,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(214,40,40,0.8)',
  },
  miniBtnText: {
    color: THEME.white,
    fontSize: 12,
    fontWeight: '700',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  clearText: {
    color: '#ff6b6b',
    fontWeight: '700',
  },
  qtyText: {
    marginTop: 6,
    color: '#ffd6a5',
    fontWeight: '700',
  },
  qtyRow: {
    marginTop: 8,
    flexDirection: 'row',
  },
  qtyBtn: {
    width: 34,
    height: 30,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  qtyBtnText: {
    color: THEME.white,
    fontSize: 18,
    fontWeight: '800',
  },
  tabBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 14,
    flexDirection: 'row',
    backgroundColor: 'rgba(18,21,30,0.95)',
    borderRadius: 16,
    padding: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  tabBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  tabBtnActive: {
    backgroundColor: THEME.red,
  },
  tabText: {
    color: THEME.dim,
    fontWeight: '700',
    fontSize: 12,
  },
  tabTextActive: {
    color: THEME.white,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.68)',
    justifyContent: 'center',
    padding: 14,
  },
  modalCard: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    padding: 16,
    backgroundColor: THEME.glass,
    maxHeight: '92%',
  },
  modalScrollContent: {
    paddingBottom: 4,
  },
  modalTitle: {
    color: THEME.white,
    fontSize: 22,
    fontWeight: '800',
  },
  modalSource: {
    color: THEME.info,
    marginTop: 2,
    marginBottom: 10,
    fontSize: 12,
  },
  modalImage: {
    width: '100%',
    height: 220,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginBottom: 12,
  },
  infoBox: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  infoLine: {
    color: THEME.white,
    fontSize: 13,
    marginBottom: 4,
  },
  priceTitle: {
    color: THEME.white,
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
  },
  modalBtnRow: {
    flexDirection: 'row',
  },
  modalBtn: {
    flex: 1,
  },
});





