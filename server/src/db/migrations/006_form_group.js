/** Group of a form inside its module in the navigation (a Postman folder or an OpenAPI tag, e.g. "APIM OWMS"). */

export async function up(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.string('form_group', 60);
  });
}

export async function down(knex) {
  await knex.schema.alterTable('forms', (t) => {
    t.dropColumn('form_group');
  });
}
