CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" serial NOT NULL,
	"hs_code" text NOT NULL,
	"group" text NOT NULL,
	"master_item" text NOT NULL,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"sku" text NOT NULL,
	"purchase_price" numeric(18, 2) NOT NULL,
	"cost_price" numeric(18, 2) NOT NULL,
	"sale_price" numeric(18, 2) NOT NULL,
	"vat_rate" numeric(7, 2) NOT NULL,
	"sd_rate" numeric(7, 2) NOT NULL,
	"opening" numeric(18, 3) NOT NULL,
	"purchased" numeric(18, 3) NOT NULL,
	"prod_receive" numeric(18, 3) NOT NULL,
	"prod_issue" numeric(18, 3) NOT NULL,
	"sold" numeric(18, 3) NOT NULL,
	"damage" numeric(18, 3) NOT NULL,
	"reorder_level" numeric(18, 3) NOT NULL,
	"active" boolean NOT NULL,
	CONSTRAINT "items_group_check" CHECK ("items"."group" in ('Raw Material','Consumable','Packing Materials','Finished Goods'))
);
--> statement-breakpoint
CREATE TABLE "master_items" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" serial NOT NULL,
	"name" text NOT NULL,
	"hs_code" text NOT NULL,
	"group" text NOT NULL,
	"category" text NOT NULL,
	"unit" text NOT NULL,
	"price_method" text NOT NULL,
	"description" text,
	"vat" numeric(7, 2) NOT NULL,
	"sd" numeric(7, 2) NOT NULL,
	"cd" numeric(7, 2) NOT NULL,
	"rd" numeric(7, 2) NOT NULL,
	"ait" numeric(7, 2) NOT NULL,
	"at" numeric(7, 2) NOT NULL,
	"override_reason" text,
	"active" boolean NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone,
	"history" jsonb,
	CONSTRAINT "master_items_group_check" CHECK ("master_items"."group" in ('Raw Material','Consumable','Packing Materials','Finished Goods')),
	CONSTRAINT "master_items_category_check" CHECK ("master_items"."category" in ('general','commercialImporter','medicine','petroleum','superShop')),
	CONSTRAINT "master_items_price_method_check" CHECK ("master_items"."price_method" in ('average','standard'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "items_sku_lower_key" ON "items" USING btree (lower("sku"));--> statement-breakpoint
CREATE INDEX "items_master_item_idx" ON "items" USING btree ("master_item");--> statement-breakpoint
CREATE INDEX "items_hs_code_idx" ON "items" USING btree ("hs_code");--> statement-breakpoint
CREATE UNIQUE INDEX "master_items_name_lower_key" ON "master_items" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "master_items_hs_code_idx" ON "master_items" USING btree ("hs_code");