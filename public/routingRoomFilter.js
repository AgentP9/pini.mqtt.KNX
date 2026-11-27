'use strict';

function filterRoutingByRoom(devices, routes, roomId) {
  const all = roomId === 'all';
  const selected = new Set(devices.filter(device => all || (roomId === 'unassigned' ? !device.roomId : device.roomId === roomId)).map(device => device.id));
  const visibleRoutes = all ? routes : routes.filter(route => [route.from, route.to].some(ref => ref.type === 'device' && selected.has(ref.id)));
  const deviceIds = new Set(selected);
  const mqttIds = new Set();
  for (const route of visibleRoutes) {
    for (const ref of [route.from, route.to]) {
      if (ref.type === 'device') deviceIds.add(ref.id);
      else mqttIds.add(ref.id);
    }
  }
  return { routes: visibleRoutes, deviceIds, mqttIds };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { filterRoutingByRoom };
