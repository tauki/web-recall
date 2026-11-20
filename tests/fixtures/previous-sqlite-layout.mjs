export const previousLayout = `
  pragma user_version=4;
  create table saved_library(id text primary key, source_version integer, pages integer, processing integer,
    active integer, page_revision integer, job_revision integer);
  create table saved_pages(url text primary key, captured_at real, title text, record text, search_record text, url_order blob);
  create index saved_pages_by_capture on saved_pages(captured_at desc, url desc);
  create unique index saved_pages_by_url_order on saved_pages(url_order);
  create table saved_processing(url text primary key, record text);
  create trigger count_page_insert after insert on saved_pages begin update saved_library set pages=pages+1 where active=1; end;
  create trigger count_page_delete after delete on saved_pages begin update saved_library set pages=pages-1 where active=1; end;
  create trigger count_page_update after update on saved_pages begin update saved_library set page_revision=page_revision+1 where active=1; end;
`;
