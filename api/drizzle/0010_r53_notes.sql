CREATE TABLE "note_lines" (
	"note_id" text NOT NULL,
	"ord" integer NOT NULL,
	"item_id" text NOT NULL,
	"name" text NOT NULL,
	"hs_code" text NOT NULL,
	"uom" text NOT NULL,
	"sold_qty" numeric(18, 3),
	"purchased_qty" numeric(18, 3),
	"qty" numeric(18, 3) NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"sd_rate" numeric(7, 2) NOT NULL,
	"vat_rate" numeric(7, 2) NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"sd" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"tti" numeric(18, 2),
	"rebate" numeric(18, 2),
	CONSTRAINT "note_lines_note_id_ord_pk" PRIMARY KEY("note_id","ord"),
	CONSTRAINT "note_lines_qty_check" CHECK (("note_lines"."sold_qty" is null) <> ("note_lines"."purchased_qty" is null)),
	CONSTRAINT "note_lines_debit_check" CHECK (("note_lines"."tti" is null and "note_lines"."rebate" is null) or "note_lines"."purchased_qty" is not null)
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" serial NOT NULL,
	"kind" text NOT NULL,
	"no" text NOT NULL,
	"source_id" text NOT NULL,
	"source_no" text NOT NULL,
	"source_date" date NOT NULL,
	"source_mode" text NOT NULL,
	"challan_no" text NOT NULL,
	"party_id" text NOT NULL,
	"party_name" text NOT NULL,
	"party_bin" text NOT NULL,
	"party_address" text NOT NULL,
	"branch_id" text NOT NULL,
	"branch_name" text NOT NULL,
	"issue_date" date NOT NULL,
	"issue_time" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"issued_by" text NOT NULL,
	"designation" text NOT NULL,
	"process" text NOT NULL,
	"subtotal" numeric(18, 2) NOT NULL,
	"sd" numeric(18, 2) NOT NULL,
	"vat" numeric(18, 2) NOT NULL,
	"total" numeric(18, 2) NOT NULL,
	"tti" numeric(18, 2),
	"rebate" numeric(18, 2),
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone,
	"cancel_reason" text,
	"history" jsonb,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "notes_kind_check" CHECK ("notes"."kind" in ('credit','debit')),
	CONSTRAINT "notes_process_check" CHECK ("notes"."process" in ('Created','Approved','Cancelled')),
	CONSTRAINT "notes_reason_check" CHECK ("notes"."reason" in ('damaged','quality','excess','wrongItem','priceAdjustment','priceDispute')),
	CONSTRAINT "notes_source_mode_check" CHECK ("notes"."source_mode" in ('Local','Foreign','Non-registered')),
	CONSTRAINT "notes_debit_totals_check" CHECK ("notes"."kind" = 'debit' or ("notes"."tti" is null and "notes"."rebate" is null))
);
--> statement-breakpoint
CREATE INDEX "note_lines_item_idx" ON "note_lines" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_no_key" ON "notes" USING btree ("no");--> statement-breakpoint
CREATE INDEX "notes_live_idx" ON "notes" USING btree ("created_at") WHERE "notes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "notes_kind_idx" ON "notes" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "notes_issue_date_idx" ON "notes" USING btree ("issue_date");--> statement-breakpoint
CREATE INDEX "notes_source_idx" ON "notes" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "notes_party_idx" ON "notes" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "notes_branch_idx" ON "notes" USING btree ("branch_id");