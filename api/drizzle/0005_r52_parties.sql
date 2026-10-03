CREATE TABLE "parties" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" serial NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"bin" text DEFAULT '' NOT NULL,
	"mode" text NOT NULL,
	"mobile" text DEFAULT '' NOT NULL,
	"address" text NOT NULL,
	"country" text,
	"email" text,
	"contact_person" text,
	"active" boolean,
	"credit_limit" numeric(18, 2),
	"vds_withholder" boolean,
	"exporter_type" text,
	"bond_license_no" text,
	"bond_license_expiry" date,
	"association_no" text,
	"deleted_at" timestamp (3) with time zone,
	CONSTRAINT "parties_kind_check" CHECK ("parties"."kind" in ('customer','vendor')),
	CONSTRAINT "parties_exporter_check" CHECK ("parties"."exporter_type" is null or "parties"."exporter_type" in ('direct','deemed'))
);
--> statement-breakpoint
CREATE INDEX "parties_live_kind_idx" ON "parties" USING btree ("kind") WHERE "parties"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "parties_live_name_key" ON "parties" USING btree ("kind",lower(btrim("name"))) WHERE "parties"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "parties_live_bin_key" ON "parties" USING btree ("kind",regexp_replace("bin", '^NID ', '')) WHERE "parties"."bin" <> '' and "parties"."deleted_at" is null;