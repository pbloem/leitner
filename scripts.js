'use strict';

String.prototype.hash = function() {
    var hash = 0, i = 0, len = this.length;
    while ( i < len ) {
        hash  = ((hash << 5) - hash + this.charCodeAt(i++)) << 0;
    }
    return hash;
};

var lt = { // * top-level namespace
	
	init : function() 
	{
// 		let request = window.indexedDB.open('leitner', 2);
// 		
// 		request.onerror   = function() {
// 			console.log('Database failed to open'); 
// 		};
// 		
// 		request.onsuccess = function() {
// 			console.log('Database opened successfully'); 
// 			lt.db = request.result;
// 		};
// 
// 		// Setup the database tables if this has not already been done
// 		request.onupgradeneeded = function(e) 
// 		{
// 			let db = e.target.result;
// 
// 			// table for card-answering events
// 			let store = db.createObjectStore('events', { keyPath: 'id', autoIncrement:true });
// 
// 			// the deck from which the cards came
// 			store.createIndex('deck', 'deck', { unique: false });
// 
// 			// -- timestamp of the answering event
// 			store.createIndex('timestamp', 'timestamp', { unique: false });
// 			
// 			// -- target card (the correct answer in the case of MC)
// 			store.createIndex('card', 'card', { unique: false });
// 		
// 			// -- alternative 1 (in MC questions)
// 			store.createIndex('alt1', 'alt1', { unique: false });
// 			
// 			// -- alternative 2 (in MC questions)
//   			store.createIndex('alt2', 'alt2', { unique: false });
//   			
//   			// -- result of the answering event (positive for correct, negative for incorrect)
// 			store.createIndex('result', 'result', { unique: false });
// 
// 			console.log('Database setup complete.');
// 		};

		lt.db = new Dexie('leitner')
		
		lt.db.version(1).stores({
              events: 'id++, timestamp, deck, card, alt1, alt2, result, [deck+card], [deck+card+result]'
        });
		
		
	},
	
	deck_files : [
		'../decks/hanzi01.json',
		'../decks/capitals.json',
	],
	
	templates : { mc: $.templates("#mc") },
	
	sounds: {
		correct: new Audio('/sounds/correct.mp3'),
		incorrect: new Audio('/sounds/incorrect.wav')
	},
	
	decks : {},
	
	/**
	 * Takes a dictionary representing a deck, enriches it, and adds it to the set of 
	 * decks in the namespace.
	 */
	loadDeck : function(deck) 
	{
		deck.cards.forEach((card) => 
		{		
			// - generate (sufficiently) unique IDs for cards that don't
			//   have them
			if (!( 'id' in card))
			{
				let sumstr = '';
				for (var side of card.sides)
					sumstr += side + ', ';
					
				card.id = sumstr.hash()		
			}
		});
		
		if (!( 'id' in deck))
			deck.id = (deck.name + '').hash()		
		
		lt.decks[deck.name] = deck
		
		console.log(deck.name + ' loaded')
	},

	computeScores : function(deck)
	{
		deck.cards.forEach((card) => 
		{
			let cardId = card.id
			let deckId = deck.id

			let cards = lt.db.events
				.where('[deck+card+result]').equals([deckId,cardId,0]).sortBy('timestamp')
				.then(function(events){
					if (events.length > 0)
						console.log(card.sides[0] + ' ' + events[0].timestamp)
				});
		});		
	},
	
	// * sub-namespace for the current session
	session : {
	
		startSession : function(deck)
		{

			lt.session.deck = deck
			lt.computeScores(deck)
			
			lt.session.generate();
		},
	
		generate : function() 
		{
			let deck = lt.session.deck
			$("article").empty();

			// generate a question
			// -- sample three cards. The first is the target, the other two provide false answers
			let sample = _.sampleSize(deck.cards, 3);
			let corr = _.sample([0, 1, 2]);

			let q = sample[corr].sides[0];

			$("article").html(
				lt.templates.mc.render({
					question: q,
					answer0: sample[0].sides[1],
					answer1: sample[1].sides[1],
					answer2: sample[2].sides[1]
				})
			)

			if (q.length < 4)
				$(".frame .question").addClass("short")
			else if (q.length < 10)
				$(".frame .question").addClass("medium")
			
			$("article .frame button").on(
				'click',
				{ 
			      timestamp: Date.now(),
			      deck: deck.id,
				  card: sample[0].id,
				  alt1: sample[1].id,
				  alt2: sample[2].id,
 				  result: corr
				},
				lt.session.processAnswer
			)            
		},
	
		processAnswer : function(e)
		{
			let answered = $(e.target).data('answer')
			let correct = e.data.result
			
			// * write event to db
// 			let trs = lt.db.transaction(["events"], "readwrite");
// 			
// 			trs.oncomplete = function(e){console.log('Event stored')};
// 			trs.onerror = function(e){console.log(e)};
// 			
// 			let events = trs.objectStore("events");
// 			let rq = events.add(e.data)

			console.log(e.data)
			lt.db.events.add(e.data)

			if(answered == correct)
			{
// 				$('article').append('Correct!');
				lt.sounds.correct.play()
			
				$('article button').attr('disabled', true);
			
				setTimeout(lt.session.generate , 750)
			} else
			{
// 				$('article').append('Incorrect!');
				lt.sounds.incorrect.play()
			}
		},
	}
}

$(function() 
{

	// - init database
	lt.init();

	// - load decks
	var rqs = Array();
	lt.deck_files.forEach(function(df)
	{
		rqs.push($.getJSON(df, lt.loadDeck));
	});
	
	var defer = $.when.apply($, rqs);
	defer.done(function() {
		let params = new URLSearchParams(window.location.search);
		
		if (params.has('deck'))
		{
			lt.session.startSession(lt.decks[params.get('deck')]);
		} else
		{
			$("article").append('<p>No deck specified.</p>')
		}	
	});


});