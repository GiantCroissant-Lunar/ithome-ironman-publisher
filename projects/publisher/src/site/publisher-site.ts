import type { CalendarDate } from '../domain/date.js';
import type { LocalArticle } from '../content/article.js';
import type {
  ArticleAssetState,
  ArticleRuntimeState,
  DiscoveredSiteState,
} from '../state/publisher-state.js';

export interface PublicArticle {
  title: string;
  url: string;
  publishedDate?: CalendarDate;
}

export interface PublicArticleSnapshot {
  articles: PublicArticle[];
  listingRecognized: boolean;
  dateEvidenceComplete: boolean;
}

export interface DraftArticle {
  title: string;
  url: string;
}

export interface DraftSyncResult {
  draft: DraftArticle;
  action: 'created' | 'updated';
  uploadedImages: number;
  sourceHash: string;
  renderedHash: string;
  assets: Record<string, ArticleAssetState>;
}

export interface PublisherSite {
  assertAuthenticated(): Promise<void>;
  getPublicArticleSnapshot(today: CalendarDate): Promise<PublicArticleSnapshot>;
  listDrafts(): Promise<DraftArticle[]>;
  syncDraft(
    article: LocalArticle,
    existingDraft: DraftArticle | undefined,
    previousState?: ArticleRuntimeState,
  ): Promise<DraftSyncResult>;
  publishDraft(draft: DraftArticle): Promise<void>;
  discoverPublishedContext(articleUrl: string): Promise<DiscoveredSiteState>;
  getDiscoveredState(): DiscoveredSiteState;
}
