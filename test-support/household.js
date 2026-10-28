export function seedTestMembers(app) {
  if (app.getServerSettings().members.length) return;
  app.saveServerSettings({ members: Array.from({length:5}, (_,i)=>({name:`メンバー${i+1}`,active:true})), schedule: app.getServerSettings().upcoming });
}
