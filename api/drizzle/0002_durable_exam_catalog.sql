ALTER TABLE "exams" ADD COLUMN "slug" varchar(200);--> statement-breakpoint
UPDATE "exams" SET "slug" = 'legacy-' || "id"::text WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "exams" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "exams_slug_uq" ON "exams" USING btree ("slug");