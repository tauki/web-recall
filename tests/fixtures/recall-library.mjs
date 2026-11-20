export const CORPUS_VERSION = 'everyday-recall-v1';
export const LENGTH_WORDS = { short: 250, medium: 1500, long: 6000, reference: 100000 };
const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86400000;
const domains = { article: 'reading.benchmark.test', documentation: 'docs.benchmark.test', forum: 'forum.benchmark.test', dynamic: 'app.benchmark.test' };
const slugs = { outbox: 'transactional-outbox', tomatoes: 'yellow-tomato-leaves' };
const themes = [
  ['Workshop planning', 'A small workshop compares its tools, work surfaces and room for storing unfinished projects.'],
  ['Container gardens', 'Garden observations record pot sizes, weather exposure and how the planting changes over a season.'],
  ['Rail connections', 'A travel notebook compares transfers, platform access and the value of keeping an alternative route.'],
  ['Kitchen arrangements', 'The household compares cookware storage, preparation space and noise while making an ordinary meal.'],
  ['Browser interfaces', 'A browser interface should keep useful content accessible when its available screen space changes.'],
  ['Research collections', 'A research collection keeps the source, capture date and related observations together for later comparison.'],
  ['Outdoor observations', 'Field observations record the place, weather and viewing conditions before drawing a broader conclusion.'],
  ['Photography practice', 'A photograph records both the chosen composition and the lighting conditions at a particular moment.'],
  ['Local model services', 'A local model service has a configuration, an operational state and a set of available resources.'],
  ['Software boundaries', 'A team compares ownership, deployment and data boundaries before changing a software system.'],
  ['Household comfort', 'Household notes compare room layout, light, noise and seasonal conditions without assuming a single cause.'],
  ['Archive visits', 'An archive visit produces references that must remain understandable after the researcher returns home.'],
  ['Cooking experiments', 'A cooking experiment records ingredients, equipment and changes between attempts so the result can be compared.'],
  ['Community questions', 'A community discussion is more useful when the original question and the later follow-up remain together.'],
  ['Application reliability', 'Application reliability involves observing interruptions, recording outcomes and preserving earlier evidence.'],
  ['Material samples', 'Material samples show how preparation and handling affect the final surface and shape of a piece.']
];
const paragraphs = [
  'The notes distinguish an observation from an explanation. A later comparison is easier when the original conditions and the reason for a change have been recorded.',
  'A short example is useful for learning the vocabulary, but a larger example can expose interactions that were hidden at first. Both remain in the notebook rather than replacing one another.',
  'The group compares two approaches under similar conditions and records what stayed the same. This makes disagreement easier to investigate without assuming that every difference has one cause.',
  'Readers can return to the surrounding context before relying on a brief quotation. A title or summary helps locate an item, while the full record explains how the observation was made.',
  'A small practical limitation may determine which approach is comfortable to use. The discussion keeps that limitation separate from claims about what is possible in every setting.',
  'The first attempt is not treated as a final verdict. Follow-up notes record changes, unexpected outcomes and the remaining questions without silently erasing the earlier account.',
  'The description names the intended task before discussing equipment or technique. A useful comparison explains who is doing the work and what counts as a satisfactory result.',
  'Several similar-looking examples have different histories. The notebook preserves their names and dates so that later reading does not combine evidence from unrelated situations.'
];

export function topicUrl(topic) { return topic.url || `https://${domains[topic.type]}/${slugs[topic.id] || topic.id}`; }
export function captureTime(date) { return Date.parse(date + 'T12:00:00.000Z'); }
export function lengthClass(index) {
  const bucket = index * 37 % 100;
  return bucket < 50 ? 'short' : bucket < 85 ? 'medium' : bucket < 99 ? 'long' : 'reference';
}

function expandedText(title, introduction, words, index, type, placement) {
  const theme = themes[index % themes.length];
  const sections = [];
  const opening = `# ${title}\n\n${placement === 'end' ? theme[1] : introduction}`;
  let remaining = Math.max(0, words - opening.split(/\s+/u).length - introduction.split(/\s+/u).length);
  for (let section = 0; remaining > 0; section++) {
    const content = `${type === 'forum' ? 'Reply' : 'Section'} ${section + 1}: ${theme[0]}. ${paragraphs[(index * 3 + section * 5) % paragraphs.length]} ${theme[1]} Observation ${index + 1}.${section + 1}.`;
    const tokens = content.split(/\s+/u).slice(0, remaining);
    sections.push(tokens.join(' ')); remaining -= tokens.length;
  }
  return [opening, ...sections, `## Closing notes\n\n${introduction}`].join('\n\n');
}

function vector(seed) {
  let state = seed | 1;
  return Array.from({ length: 768 }, () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 8) / 268435456; });
}

function chunksFor(text, indexed, index) {
  const words = text.split(/\s+/u), chunks = [];
  for (let start = 0; start < words.length; start += 512) chunks.push({ text: words.slice(start, start + 512).join(' '), embedding: indexed ? vector(index * 1009 + start + 1) : [], ...(indexed ? { embeddingKey: 'synthetic-storage-profile-768-v1' } : {}) });
  return chunks;
}

export function topicPage(topic, index) {
  const category = topic.id === 'terns' ? 'reference' : lengthClass(index);
  const text = expandedText(topic.title, topic.text, LENGTH_WORDS[category], index, topic.type, ['archives', 'outbox', 'terns'].includes(topic.id) ? 'end' : undefined);
  const timestamp = captureTime(topic.date), indexed = index % 4 === 0;
  const history = topic.history ? [{ versionId: `${topic.id}-v1`, title: topic.history.title, timestamp: captureTime(topic.history.date), firstCapturedAt: captureTime(topic.history.date), text: expandedText(topic.history.title, topic.history.text, 1500, index, topic.type), chunks: [], kept: true, manual: true }] : [];
  return { url: topicUrl(topic), title: topic.title, text, timestamp, firstCapturedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, versionId: `${topic.id}-v2`, manual: index % 3 === 0, chunks: chunksFor(text, indexed, index), captureInfo: { source: topic.type === 'article' ? 'article' : 'main', warnings: topic.type === 'dynamic' ? ['Collapsed content was not captured.'] : [] }, ...(history.length ? { versions: history } : {}) };
}

export function* buildLibrary(count, topics) {
  if (!Number.isSafeInteger(count) || count < topics.length) throw Error('The library must include every authored topic.');
  for (let index = 0; index < count; index++) {
    if (index < topics.length) { yield topicPage(topics[index], index); continue; }
    const category = lengthClass(index), type = ['article', 'documentation', 'forum', 'dynamic'][index % 4];
    const theme = themes[(index * 7) % themes.length];
    const title = `${theme[0]}: reading notebook ${index}`;
    const url = type === 'dynamic' ? `https://app.benchmark.test/library#/notes/${index}` : `https://${domains[type]}/notebook/${index}`;
    const text = expandedText(title, theme[1], LENGTH_WORDS[category], index, type);
    const timestamp = NOW - (Math.floor(index / 7) % 4 === 0 ? 1200 + index % 1100 : index % 730) * DAY;
    const indexed = Math.floor(index / 4) % 4 === 0;
    const versions = Math.floor(index / 4) % 10 === 0 ? [{ versionId: `notebook-${index}-v1`, timestamp: timestamp - 180 * DAY, title: `${theme[0]}: earlier notebook`, text: expandedText(title, theme[1], 500, index + 1, type), chunks: [], kept: index % 20 === 0 }] : [];
    yield { url, title, text, timestamp, firstCapturedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, versionId: `notebook-${index}-v2`, manual: index % 3 === 0, chunks: chunksFor(text, indexed, index), ...(versions.length ? { versions } : {}) };
  }
}
