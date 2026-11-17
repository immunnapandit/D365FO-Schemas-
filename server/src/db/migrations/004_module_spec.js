/** Keeps the OpenAPI file a module was imported from, so admins can view, edit and re-import it. */

export async function up(knex) {
  await knex.schema.alterTable('modules', (t) => {
    t.text('spec'); // encrypted YAML/JSON
    t.string('spec_file_name', 200);
    t.string('spec_updated_at', 32);
    t.string('spec_updated_by', 200);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('modules', (t) => {
    t.dropColumn('spec');
    t.dropColumn('spec_file_name');
    t.dropColumn('spec_updated_at');
    t.dropColumn('spec_updated_by');
  });
}
