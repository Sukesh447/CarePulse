/* CarePulse - service worker: shows notifications with "Mark taken" / "Snooze" buttons */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function(e){
  const d = e.notification.data || {};
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list){
    list.forEach(function(c){ c.postMessage({type: e.action || 'open', medId: d.medId, time: d.time}); });
    if(list.length && 'focus' in list[0]) return list[0].focus();
    return self.clients.openWindow('./');
  }));
});