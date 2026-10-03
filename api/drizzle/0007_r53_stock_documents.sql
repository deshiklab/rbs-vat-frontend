CREATE TABLE "stock_document_lines" (
	"doc_id" text NOT NULL,
	"ord" integer NOT NULL,
	"item_id" text NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"uom" text NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"cost" numeric(18, 2) NOT NULL,
	"value" numeric(18, 2) NOT NULL,
	CONSTRAINT "stock_document_lines_doc_id_ord_pk" PRIMARY KEY("doc_id","ord")
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" serial NOT NULL,
	"kind" text NOT NULL,
	"no" text NOT NULL,
	"date" date NOT NULL,
	"process" text NOT NULL,
	"from_branch_id" text NOT NULL,
	"from_branch" text NOT NULL,
	"to_branch_id" text,
	"to_branch" text,
	"reason" text,
	"vehicle" text,
	"note" text,
	"total_qty" numeric(18, 3) NOT NULL,
	"total_value" numeric(18, 2) NOT NULL,
	"issued_by" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone,
	"cancel_reason" text,
	"history" jsonb,
	CONSTRAINT "stock_documents_kind_check" CHECK ("stock_documents"."kind" in ('transfer','damage')),
	CONSTRAINT "stock_documents_process_check" CHECK ("stock_documents"."process" in ('Created','Approved','Cancelled')),
	CONSTRAINT "stock_documents_reason_check" CHECK ("stock_documents"."reason" is null or "stock_documents"."reason" in ('damaged','expired','wastage','lost')),
	CONSTRAINT "stock_documents_branches_check" CHECK (("stock_documents"."kind" = 'transfer' and "stock_documents"."to_branch_id" is not null) or ("stock_documents"."kind" = 'damage' and "stock_documents"."to_branch_id" is null and "stock_documents"."reason" is not null))
);
--> statement-breakpoint
CREATE INDEX "stock_document_lines_item_idx" ON "stock_document_lines" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_no_key" ON "stock_documents" USING btree ("no");--> statement-breakpoint
CREATE INDEX "stock_documents_kind_created_idx" ON "stock_documents" USING btree ("kind","created_at");